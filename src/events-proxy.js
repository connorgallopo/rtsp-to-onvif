const crypto = require('crypto');
const { forwardSoap, upstreamUrl } = require('./soap-forwarder');

const MAX_SUBSCRIPTIONS = 32;
const SWEEP_INTERVAL_MS = 60_000;
const DEFAULT_TTL_MS = 3600_000;
const SWEEP_GRACE_MS = 300_000;

const FAULT_REWRITE_FAILED = '<?xml version="1.0"?><s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope"><s:Body><s:Fault><s:Code><s:Value>s:Receiver</s:Value></s:Code><s:Reason><s:Text>proxy address rewrite failed</s:Text></s:Reason></s:Fault></s:Body></s:Envelope>';
const NOTIFICATION_RE = /<\s*(?:[\w-]+:)?NotificationMessage\b[\s\S]*?<\s*\/\s*(?:[\w-]+:)?NotificationMessage\s*>/g;
const MESSAGE_SOURCE_RE = /<\s*(?:[\w-]+:)?Source\b[^>]*>([\s\S]*?)<\s*\/\s*(?:[\w-]+:)?Source\s*>/;
const SIMPLE_ITEM_RE = /<\s*(?:[\w-]+:)?SimpleItem\b[^>]*>/g;
const SOURCE_ITEM_NAMES = new Set(['VideoSourceConfigurationToken', 'VideoSourceToken', 'Source']);
const WSA_TO_RE = /(<\s*(?:[\w-]+:)?To\b[^>]*>)[\s\S]*?(<\s*\/\s*(?:[\w-]+:)?To\s*>)/;

function rewriteWsaTo(body, url) {
    const escaped = url.replace(/&(?!amp;)/g, '&amp;');
    const out = body.replace(WSA_TO_RE, (_, open, close) => `${open}${escaped}${close}`);
    return out === body ? null : out;
}
const FAULT_SUBSCRIPTION_CAP ='<?xml version="1.0"?><s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope"><s:Body><s:Fault><s:Code><s:Value>s:Sender</s:Value></s:Code><s:Reason><s:Text>subscription limit reached</s:Text></s:Reason></s:Fault></s:Body></s:Envelope>';

module.exports = class EventsProxy {
    constructor(logger, config) {
        this.logger = logger;
        this.config = config;
        this.subscriptions = new Map();
        // Only set for cams behind a shared NVR endpoint, whose pull points
        // return every channel's events.
        this.sourceToken = (config.target.tokens || {}).videoSource;
        this.cleanupTimer = setInterval(() => this.sweepExpired(), SWEEP_INTERVAL_MS);
        if (this.cleanupTimer.unref) this.cleanupTimer.unref();
    }

    matches(pathname) {
        return pathname === '/onvif/Events'
            || pathname === '/onvif/events_service'
            || pathname.startsWith('/onvif/subscription/');
    }

    upstreamEventsUrl() {
        return upstreamUrl(this.config, '/onvif/Events');
    }

    async handle(request, response) {
        const pathname = request.url.split('?')[0];
        const isSubscriptionUrl = pathname.startsWith('/onvif/subscription/');

        let target;
        if (isSubscriptionUrl) {
            const localId = pathname.slice('/onvif/subscription/'.length);
            const sub = this.subscriptions.get(localId);
            if (!sub) {
                this.logger.info(`EVENTS: ${this.config.name} - unknown subscription ${localId}`);
                response.writeHead(404, { 'content-type': 'text/plain' });
                response.end('Subscription not found');
                return;
            }
            target = sub.upstreamManagerUrl;
        } else {
            target = this.upstreamEventsUrl();
        }

        await forwardSoap({
            logger: this.logger,
            name: `${this.config.name}/events`,
            request, response,
            upstreamUrl: target,
            // The client addresses wsa:To at our subscription URL; Reolink
            // routes pull points by wsa:To and returns 400 when it's ours.
            rewriteRequest: isSubscriptionUrl ? (body) => rewriteWsaTo(body, target) : undefined,
            rewriteResponse: (respBody, reqBody) => {
                if (!isSubscriptionUrl && /CreatePullPointSubscription/i.test(reqBody)) {
                    return this.rewriteSubscriptionAddress(respBody);
                }
                if (isSubscriptionUrl) {
                    const localId = pathname.slice('/onvif/subscription/'.length);
                    if (this.sourceToken && /PullMessagesResponse/.test(respBody)) {
                        return this.filterNotifications(respBody);
                    }
                    if (/Unsubscribe/.test(reqBody) && /UnsubscribeResponse/.test(respBody)) {
                        if (this.subscriptions.delete(localId)) {
                            this.logger.info(`EVENTS: ${this.config.name} - unsubscribed ${localId}`);
                        }
                    } else if (/Renew/.test(reqBody) && /RenewResponse/.test(respBody)) {
                        const sub = this.subscriptions.get(localId);
                        if (sub) {
                            const m = respBody.match(/<\s*(?:[\w-]+:)?TerminationTime\b[^>]*>([^<]+)/i);
                            const parsed = m && Date.parse(m[1].trim());
                            if (parsed && !Number.isNaN(parsed)) sub.terminationTime = parsed;
                        }
                    }
                }
                return null;
            },
        });
    }

    rewriteSubscriptionAddress(body) {
        const re = /(<\s*(?:[\w-]+:)?SubscriptionReference\b[^>]*>[\s\S]*?<\s*(?:[\w-]+:)?Address\b[^>]*>)([\s\S]*?)(<\s*\/\s*(?:[\w-]+:)?Address\s*>)/i;
        const m = body.match(re);
        if (!m) {
            this.logger.error(`EVENTS: ${this.config.name} - SubscriptionReference/Address not found in upstream response; refusing to leak upstream URL`);
            return FAULT_REWRITE_FAILED;
        }
        if (this.subscriptions.size >= MAX_SUBSCRIPTIONS) {
            this.logger.warn(`EVENTS: ${this.config.name} - subscription cap reached (${MAX_SUBSCRIPTIONS})`);
            return FAULT_SUBSCRIPTION_CAP;
        }
        const upstreamUrl = m[2].trim();
        const localId = crypto.randomUUID();
        this.subscriptions.set(localId, {
            upstreamManagerUrl: upstreamUrl,
            createdAt: Date.now(),
            terminationTime: Date.now() + DEFAULT_TTL_MS,
        });
        const ourUrl = `http://${this.config.hostname}:${this.config.ports.server}/onvif/subscription/${localId}`;
        this.logger.info(`EVENTS: ${this.config.name} - subscription ${localId} -> ${upstreamUrl}`);
        return body.replace(re, `$1${ourUrl}$3`);
    }

    filterNotifications(body) {
        const out = body.replace(NOTIFICATION_RE, (msg) => {
            const source = msg.match(MESSAGE_SOURCE_RE);
            if (!source) return msg;
            let tagged = false;
            for (const item of source[1].match(SIMPLE_ITEM_RE) || []) {
                const name = (item.match(/\bName="([^"]*)"/) || [])[1];
                if (!SOURCE_ITEM_NAMES.has(name)) continue;
                tagged = true;
                if ((item.match(/\bValue="([^"]*)"/) || [])[1] === this.sourceToken) return msg;
            }
            return tagged ? '' : msg;
        });
        return out === body ? null : out;
    }

    sweepExpired() {
        const now = Date.now();
        for (const [id, sub] of this.subscriptions.entries()) {
            if (sub.terminationTime < now - SWEEP_GRACE_MS) {
                this.subscriptions.delete(id);
                this.logger.info(`EVENTS: ${this.config.name} - sweeping expired subscription ${id}`);
            }
        }
    }
};
