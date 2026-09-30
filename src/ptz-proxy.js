const { forwardSoap, upstreamTokens, upstreamUrl, rewriteTokens } = require('./soap-forwarder');

module.exports = class PtzProxy {
    constructor(logger, config) {
        this.logger = logger;
        this.config = config;
        const tokens = upstreamTokens(config);
        this.profileTokenMap = {
            main_stream: tokens.main,
            sub_stream: tokens.sub,
        };
    }

    matches(pathname) {
        return pathname === '/onvif/PTZ' || pathname === '/onvif/ptz_service';
    }

    upstreamPtzUrl() {
        return upstreamUrl(this.config, '/onvif/PTZ');
    }

    async handle(request, response, body) {
        await forwardSoap({
            logger: this.logger,
            name: `${this.config.name}/ptz`,
            request, response, body,
            upstreamUrl: this.upstreamPtzUrl(),
            rewriteRequest: (body) => rewriteTokens(body, this.profileTokenMap),
        });
    }
};
