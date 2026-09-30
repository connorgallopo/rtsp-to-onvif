const https = require('https');
const { readBody } = require('./soap-forwarder');
const PtzProxy = require('./ptz-proxy');

// Reolink NVRs answer ONVIF ContinuousMove/Stop with 200 but never move the
// camera. Their own PtzCtrl API does, so those two operations go through it
// and every other PTZ call keeps going to the NVR over ONVIF.

const PTZ_NS = 'http://www.onvif.org/ver20/ptz/wsdl';
const TOKEN_MARGIN_MS = 60_000;
const insecureAgent = new https.Agent({ rejectUnauthorized: false });

function soapEnvelope(body) {
    return `<?xml version="1.0" encoding="UTF-8"?><s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope" xmlns:tptz="${PTZ_NS}"><s:Body>${body}</s:Body></s:Envelope>`;
}

function soapFault(reason) {
    return soapEnvelope(`<s:Fault><s:Code><s:Value>s:Receiver</s:Value></s:Code><s:Reason><s:Text xml:lang="en">${reason}</s:Text></s:Reason></s:Fault>`);
}

function vectorComponent(body, element, axis) {
    const tag = body.match(new RegExp(`<\\s*(?:[\\w-]+:)?${element}\\b[^>]*>`));
    if (!tag) return 0;
    const value = tag[0].match(new RegExp(`\\b${axis}="([^"]*)"`));
    return value ? Number(value[1]) || 0 : 0;
}

// ONVIF velocity: +x pans right, +y tilts up, +zoom zooms in.
function continuousMoveToPtzCtrl(body) {
    const x = vectorComponent(body, 'PanTilt', 'x');
    const y = vectorComponent(body, 'PanTilt', 'y');
    const z = vectorComponent(body, 'Zoom', 'x');
    const horizontal = x > 0 ? 'Right' : x < 0 ? 'Left' : '';
    const vertical = y > 0 ? 'Up' : y < 0 ? 'Down' : '';
    let op;
    let magnitude;
    if (horizontal || vertical) {
        op = horizontal + vertical;
        magnitude = Math.max(Math.abs(x), Math.abs(y));
    } else if (z) {
        op = z > 0 ? 'ZoomInc' : 'ZoomDec';
        magnitude = Math.abs(z);
    } else {
        return { op: 'Stop' };
    }
    return { op, speed: Math.min(64, Math.max(1, Math.round(magnitude * 64))) };
}

module.exports = class ReolinkPtz {
    constructor(logger, config) {
        this.logger = logger;
        this.config = config;
        this.channel = config.target.reolink.channel;
        this.onvifPtz = new PtzProxy(logger, config);
        this.token = null;
        this.tokenExpiresAt = 0;
        if (!process.env.REOLINK_USERNAME || !process.env.REOLINK_PASSWORD) {
            logger.error(`PTZ: ${config.name} - target.reolink is set but REOLINK_USERNAME / REOLINK_PASSWORD are not`);
        }
    }

    matches(pathname) {
        return this.onvifPtz.matches(pathname);
    }

    async handle(request, response) {
        const body = (await readBody(request)).toString('utf8');
        const operation = /<\s*(?:[\w-]+:)?ContinuousMove\b/.test(body) ? 'ContinuousMove'
            : /<\s*(?:[\w-]+:)?Stop\b/.test(body) ? 'Stop'
                : null;
        if (!operation) {
            return this.onvifPtz.handle(request, response, body);
        }

        const command = operation === 'Stop' ? { op: 'Stop' } : continuousMoveToPtzCtrl(body);
        try {
            await this.ptzCtrl(command);
            this.logger.debug(`PTZ: ${this.config.name} - ${operation} -> PtzCtrl ${command.op}${command.speed ? ` speed ${command.speed}` : ''}`);
            response.writeHead(200, { 'content-type': 'application/soap+xml; charset=utf-8' });
            response.end(soapEnvelope(`<tptz:${operation}Response/>`));
        } catch (err) {
            this.logger.error(`PTZ: ${this.config.name} - PtzCtrl ${command.op} failed: ${err.message}`);
            response.writeHead(500, { 'content-type': 'application/soap+xml; charset=utf-8' });
            response.end(soapFault(`Reolink PtzCtrl failed: ${err.message}`));
        }
    }

    async ptzCtrl(command) {
        const param = { channel: this.channel, op: command.op };
        if (command.speed) param.speed = command.speed;
        let result = await this.api('PtzCtrl', param, await this.getToken());
        if (result.code !== 0) {
            this.token = null;
            result = await this.api('PtzCtrl', param, await this.getToken());
        }
        if (result.code !== 0) {
            throw new Error(JSON.stringify(result.error || result));
        }
    }

    async getToken() {
        if (this.token && Date.now() < this.tokenExpiresAt) return this.token;
        const result = await this.api('Login', {
            User: { Version: '0', userName: process.env.REOLINK_USERNAME, password: process.env.REOLINK_PASSWORD },
        });
        if (result.code !== 0 || !result.value || !result.value.Token) {
            throw new Error(`login failed: ${JSON.stringify(result.error || result)}`);
        }
        this.token = result.value.Token.name;
        this.tokenExpiresAt = Date.now() + result.value.Token.leaseTime * 1000 - TOKEN_MARGIN_MS;
        return this.token;
    }

    api(cmd, param, token) {
        const path = `/api.cgi?cmd=${cmd}${token ? `&token=${token}` : ''}`;
        const payload = JSON.stringify([{ cmd, action: 0, param }]);
        return new Promise((resolve, reject) => {
            const req = https.request({
                host: this.config.target.hostname,
                port: 443,
                path,
                method: 'POST',
                agent: insecureAgent,
                headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) },
                timeout: 10000,
            }, (res) => {
                let data = '';
                res.on('data', (c) => { data += c; });
                res.on('end', () => {
                    try {
                        resolve(JSON.parse(data)[0]);
                    } catch (err) {
                        reject(new Error(`unparseable ${cmd} response (${res.statusCode}): ${data.slice(0, 120)}`));
                    }
                });
            });
            req.on('timeout', () => req.destroy(new Error(`${cmd} timed out`)));
            req.on('error', reject);
            req.end(payload);
        });
    }
};

module.exports.continuousMoveToPtzCtrl = continuousMoveToPtzCtrl;
