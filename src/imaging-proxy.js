const { forwardSoap, upstreamTokens, upstreamUrl, rewriteTokens } = require('./soap-forwarder');

module.exports = class ImagingProxy {
    constructor(logger, config) {
        this.logger = logger;
        this.config = config;
        this.videoSourceTokenMap = {
            video_src_token: upstreamTokens(config).videoSource,
        };
    }

    matches(pathname) {
        return pathname === '/onvif/Imaging' || pathname === '/onvif/imaging_service';
    }

    upstreamImagingUrl() {
        return upstreamUrl(this.config, '/onvif/Imaging');
    }

    async handle(request, response) {
        await forwardSoap({
            logger: this.logger,
            name: `${this.config.name}/imaging`,
            request, response,
            upstreamUrl: this.upstreamImagingUrl(),
            rewriteRequest: (body) => rewriteTokens(body, this.videoSourceTokenMap),
        });
    }
};
