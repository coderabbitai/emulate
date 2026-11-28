import { createHmac } from "crypto";

export interface WebhookSubscription {
  id: number;
  url: string;
  events: string[];
  active: boolean;
  secret?: string;
  owner: string;
  repo?: string;
}

export interface WebhookDelivery {
  id: number;
  hook_id: number;
  event: string;
  action?: string;
  payload: unknown;
  status_code: number | null;
  delivered_at: string;
  duration: number | null;
  success: boolean;
}

export interface WebhookHeaderContext {
  event: string;
  action?: string;
  body: string;
  subscription: Readonly<WebhookSubscription>;
  deliveryId: number;
}

export type WebhookHeaderFactory = (context: WebhookHeaderContext) => Record<string, string>;

const MAX_DELIVERIES = 1000;

function githubHeaders({ event, body, subscription, deliveryId }: WebhookHeaderContext): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-GitHub-Event": event,
    "X-GitHub-Delivery": String(deliveryId),
  };

  if (subscription.secret) {
    const hmac = createHmac("sha256", subscription.secret).update(body).digest("hex");
    headers["X-Hub-Signature-256"] = `sha256=${hmac}`;
  }

  return headers;
}

export class WebhookDispatcher {
  private subscriptions: WebhookSubscription[] = [];
  private deliveries: WebhookDelivery[] = [];
  private retryTimers = new Set<ReturnType<typeof setTimeout>>();
  private subscriptionIdCounter = 1;
  private deliveryIdCounter = 1;
  private headerFactory: WebhookHeaderFactory = githubHeaders;

  setHeaderFactory(factory: WebhookHeaderFactory): void {
    this.headerFactory = factory;
  }

  register(sub: Omit<WebhookSubscription, "id"> & { id?: number }): WebhookSubscription {
    const { id: explicitId, ...rest } = sub;
    const id = explicitId !== undefined ? explicitId : this.subscriptionIdCounter++;
    if (id >= this.subscriptionIdCounter) {
      this.subscriptionIdCounter = id + 1;
    }
    const subscription: WebhookSubscription = { ...rest, id };
    this.subscriptions.push(subscription);
    return subscription;
  }

  unregister(id: number): boolean {
    const idx = this.subscriptions.findIndex((s) => s.id === id);
    if (idx === -1) return false;
    this.subscriptions.splice(idx, 1);
    return true;
  }

  getSubscription(id: number): WebhookSubscription | undefined {
    return this.subscriptions.find((s) => s.id === id);
  }

  getSubscriptions(owner?: string, repo?: string): WebhookSubscription[] {
    return this.subscriptions.filter((s) => {
      if (owner && s.owner !== owner) return false;
      if (repo !== undefined && s.repo !== repo) return false;
      return true;
    });
  }

  updateSubscription(
    id: number,
    data: Partial<Pick<WebhookSubscription, "url" | "events" | "active" | "secret">>,
  ): WebhookSubscription | undefined {
    const sub = this.subscriptions.find((s) => s.id === id);
    if (!sub) return undefined;
    Object.assign(sub, data);
    return sub;
  }

  async dispatch(
    event: string,
    action: string | undefined,
    payload: unknown,
    owner: string,
    repo?: string,
    retryDelaysMs: readonly number[] = [],
  ): Promise<void> {
    const matchingSubs = this.subscriptions.filter((s) => {
      if (!s.active) return false;
      if (s.owner !== owner) return false;
      if (repo !== undefined) {
        if (s.repo !== repo) return false;
      } else if (s.repo !== undefined) {
        return false;
      }
      return event === "ping" || s.events.includes("*") || s.events.includes(event);
    });

    if (matchingSubs.length === 0) return;
    const body = JSON.stringify(payload);
    for (const sub of matchingSubs) {
      const attempt = async (attemptIndex: number): Promise<void> => {
        if (retryDelaysMs.length > 0 && (!sub.active || !this.subscriptions.includes(sub))) return;
        const delivery: WebhookDelivery = {
          id: this.deliveryIdCounter++,
          hook_id: sub.id,
          event,
          action,
          payload,
          status_code: null,
          delivered_at: new Date().toISOString(),
          duration: null,
          success: false,
        };
        try {
          const headers = this.headerFactory({ event, action, body, subscription: sub, deliveryId: delivery.id });
          const start = Date.now();
          const response = await fetch(sub.url, {
            method: "POST",
            headers,
            body,
            ...(retryDelaysMs.length > 0 ? { redirect: "manual" as const } : {}),
            signal: AbortSignal.timeout(10000),
          });
          delivery.duration = Date.now() - start;
          delivery.status_code = response.status;
          delivery.success = response.ok;
        } catch {
          delivery.duration = 0;
        }

        if (retryDelaysMs.length > 0 && !this.subscriptions.includes(sub)) return;
        this.deliveries.push(delivery);
        if (this.deliveries.length > MAX_DELIVERIES) {
          this.deliveries.splice(0, this.deliveries.length - MAX_DELIVERIES);
        }

        const delay = retryDelaysMs[attemptIndex];
        if (!delivery.success && delay !== undefined) {
          const timer = setTimeout(() => {
            this.retryTimers.delete(timer);
            void attempt(attemptIndex + 1);
          }, delay);
          this.retryTimers.add(timer);
          timer.unref();
        }
      };
      await attempt(0);
    }
  }

  getDeliveries(hookId?: number): WebhookDelivery[] {
    if (hookId !== undefined) {
      return this.deliveries.filter((d) => d.hook_id === hookId);
    }
    return [...this.deliveries];
  }

  clear(): void {
    for (const timer of this.retryTimers) clearTimeout(timer);
    this.retryTimers.clear();
    this.subscriptions.length = 0;
    this.deliveries.length = 0;
    this.subscriptionIdCounter = 1;
    this.deliveryIdCounter = 1;
  }
}
