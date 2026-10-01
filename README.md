# Virtual ONVIF proxy for UniFi Protect

UniFi Protect adopts third-party cameras over ONVIF, and plenty of cameras either don't speak ONVIF the way Protect expects or sit somewhere Protect can't reach them, like behind an NVR. This proxy stands in for each camera. It gives every camera its own IP and MAC on your LAN, answers Protect's ONVIF device and media questions itself, and passes the video, snapshots, motion events and PTZ commands through to the real hardware.

Protect sees a normal ONVIF camera. The real camera only ever talks to the proxy.

This is a fork of [p10tyr/rtsp-to-onvif](https://github.com/p10tyr/rtsp-to-onvif), which built the adoption and streaming side on top of Daniela Hase's original virtual ONVIF server. This fork adds motion events, PTZ and imaging passthrough, and support for cameras behind a Reolink NVR.

## What you get in Protect

On Protect 7.1.60 with Hikvision-family cameras:

- Live view and recording from the camera's own RTSP streams, main and sub.
- Snapshots. Protect handles the camera's digest auth itself.
- Motion events on the timeline, through Protect's third-party motion alert pipeline.
- PTZ joystick control for cameras marked `ptz: true`. Protect documents an AI Port as the requirement for third-party PTZ; with this proxy it works without one.
- Imaging settings (brightness, contrast, IR cut and so on), where the camera supports them.

Behind a Reolink RLN16-410 NVR, cameras adopt, stream and take PTZ commands. Motion events are off there for now; see the Reolink section for why.

## Devices and the settings they need

| Device | Config beyond the basics | Status |
|---|---|---|
| Hikvision and Hikvision OEM cameras (Luma) | Nothing. The defaults use Hikvision's ONVIF token names. | Running on 6 Luma cameras, 2 of them PTZ |
| Cameras behind a Reolink NVR (RLN16-410) | `target.tokens`, `imaging: false`, `events: false`, and `target.reolink.channel` on PTZ cameras. HTTP enabled on the NVR. | Running on an RLN16-410 with 11 channels, 2 of them PTZ |
| Anything else | Probably `target.tokens`. See "Other brands" below. | Untested |

## Running it

Every camera needs its own IP and MAC on your LAN. You can run all the cameras in one process, with the proxy adding an interface per camera to the host, or run one process per camera, each in its own little network namespace. Both work in Docker or without it.

One process for everything is the simplest to set up. One process per camera is the safer choice on hosts whose kernel can't route by source address, explained below.

### One container for all cameras

The container runs on the host network with `NET_ADMIN`. At startup it creates a macvlan interface on `dev` for each camera that doesn't already have one, and asks your DHCP server for its address. That's upstream's design, and what the repo's `compose.yaml` does:

```yaml
services:
  rtsp-to-onvif:
    image: ghcr.io/connorgallopo/rtsp-to-onvif:latest
    restart: unless-stopped
    network_mode: host
    cap_add:
      - NET_ADMIN
    volumes:
      - ./config.yaml:/onvif.yaml
    # environment:
    #   DEBUG: "1"
```

Without compose, the same thing is:

```bash
docker run -d --name rtsp-to-onvif --restart unless-stopped \
  --network host --cap-add NET_ADMIN \
  -v "$PWD/config.yaml:/onvif.yaml" \
  ghcr.io/connorgallopo/rtsp-to-onvif:latest
```

Start from the example config:

```bash
wget https://raw.githubusercontent.com/connorgallopo/rtsp-to-onvif/release/config.example.yaml
cp config.example.yaml config.yaml
```

Run it in the foreground the first time (`docker compose up`, or `docker run` without `-d`) and watch the cameras appear in Protect's adoption queue.

On first run the proxy fills in a MAC and UUID for any camera that doesn't have one and writes them back to `config.yaml`, which is why the mount is writable. Once those values are set they're how Protect recognizes the camera, so leave them alone.

If you'd rather pick the addresses than take them from DHCP, create the macvlans on the host before the container starts (see the systemd section for the commands). The proxy finds an existing interface by its MAC and uses it.

The catch with this mode is routing. With several macvlans on one subnet in a single network namespace, the kernel has to choose which interface each reply leaves from. Without policy routing support (`CONFIG_IP_MULTIPLE_TABLES`), every reply goes out the first one, and your router ends up pairing IPs with the wrong MACs. Some Rockchip board kernels ship without it; `zcat /proc/config.gz | grep MULTIPLE_TABLES` or `grep MULTIPLE_TABLES /boot/config-$(uname -r)` tells you. If your UniFi client list shows the virtual cameras with mixed-up IPs, run one container per camera instead.

### One container per camera

Each camera gets a container on a Docker macvlan network with a fixed IP and MAC. Every container sees exactly one interface, so replies can't leave from the wrong one, and no container needs `NET_ADMIN`. Each container gets a config holding only its own camera, with `dev: eth0` and the same `mac` the network assigns it.

```yaml
services:
  front-door:
    image: ghcr.io/connorgallopo/rtsp-to-onvif:latest
    restart: unless-stopped
    networks:
      cameras:
        ipv4_address: 192.168.1.210
        mac_address: 1A:11:B0:15:57:FD
    volumes:
      - ./front-door.yaml:/onvif.yaml:ro

  back-yard:
    image: ghcr.io/connorgallopo/rtsp-to-onvif:latest
    restart: unless-stopped
    networks:
      cameras:
        ipv4_address: 192.168.1.211
        mac_address: 1A:11:B0:51:97:FB
    volumes:
      - ./back-yard.yaml:/onvif.yaml:ro

networks:
  cameras:
    driver: macvlan
    driver_opts:
      parent: eth0
    ipam:
      config:
        - subnet: 192.168.1.0/24
          gateway: 192.168.1.1
          ip_range: 192.168.1.208/28
```

Keep `ip_range` outside your DHCP pool, or reserve those addresses for the MACs in your router.

Without compose, create the network once and start a container per camera:

```bash
docker network create -d macvlan -o parent=eth0 \
  --subnet 192.168.1.0/24 --gateway 192.168.1.1 --ip-range 192.168.1.208/28 \
  cameras

docker run -d --name front-door --restart unless-stopped \
  --network cameras --ip 192.168.1.210 --mac-address 1A:11:B0:15:57:FD \
  -v "$PWD/front-door.yaml:/onvif.yaml:ro" \
  ghcr.io/connorgallopo/rtsp-to-onvif:latest
```

The Docker host itself can't reach macvlan containers. Everything else on the LAN, Protect included, can.

Since every camera has its own address here, the `ports` values can be the same in every config file.

### Without Docker

Run it from a checkout on Node 22:

```bash
git clone -b release https://github.com/connorgallopo/rtsp-to-onvif
cd rtsp-to-onvif
npm ci --omit=dev
cp config.example.yaml config.yaml
sudo node main.js config.yaml
```

It needs root, or `CAP_NET_ADMIN`, only to create the macvlan interfaces and run `dhclient` on them. To control the addresses yourself, create the interfaces first and the proxy will use them. A systemd unit that does that for two cameras:

```ini
[Unit]
Description=RTSP to ONVIF proxy
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/opt/rtsp-to-onvif
ExecStartPre=/bin/bash -c 'ip link del rtsp2onvif_0 2>/dev/null || true'
ExecStartPre=/bin/bash -c 'ip link add rtsp2onvif_0 link eth0 address 1A:11:B0:D1:BD:FB type macvlan mode bridge'
ExecStartPre=/bin/bash -c 'ip link set rtsp2onvif_0 up'
ExecStartPre=/bin/bash -c 'ip addr add 192.168.1.240/24 dev rtsp2onvif_0'
ExecStartPre=/bin/bash -c 'ip link del rtsp2onvif_1 2>/dev/null || true'
ExecStartPre=/bin/bash -c 'ip link add rtsp2onvif_1 link eth0 address 1A:11:B0:A3:7E:02 type macvlan mode bridge'
ExecStartPre=/bin/bash -c 'ip link set rtsp2onvif_1 up'
ExecStartPre=/bin/bash -c 'ip addr add 192.168.1.231/24 dev rtsp2onvif_1'
ExecStart=/usr/bin/node main.js config.yaml
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

Point `ExecStart` at whichever Node 22 binary you have; with mise that's `~/.local/share/mise/installs/node/22/bin/node`. Everything in the routing caveat above applies here too, because all the interfaces live on the host.

The original deployment of this fork runs on a host that is also a Tailscale subnet router for the same LAN, and its unit removes Tailscale's route for that LAN from table 52 before starting. If you're in the same position and the cameras are unreachable, it's worth trying:

```ini
ExecStartPre=/bin/bash -c 'ip route del 192.168.1.0/24 dev tailscale0 table 52 2>/dev/null || true'
```

## Configuration

The config file is YAML with a list of cameras under `onvif:`. A minimal Hikvision camera looks like this:

```yaml
onvif:
  - name: FrontDoor
    dev: eth0
    target:
      hostname: 192.168.1.187
      ports:
        rtsp: 554
        snapshot: 80
    highQuality:
      rtsp: /Streaming/Channels/101/
      snapshot: /ISAPI/Streaming/Channels/101/picture
      width: 1920
      height: 1080
      framerate: 30
      bitrate: 4096
      quality: 4
    ports:
      server: 8081
      rtsp: 8554
      snapshot: 8080
```

### Per-camera settings

| Setting | Default | What it does |
|---|---|---|
| `name` | required | Name Protect shows. Letters and digits only. |
| `dev` | required | Network interface the camera's macvlan hangs off. In a per-camera container this is `eth0`. |
| `mac` | generated | MAC of the virtual camera. Generated with a `1A:11:B0` prefix and saved if missing. Keep it fixed once the camera is adopted. |
| `uuid` | generated | ONVIF device ID. Generated and saved if missing. Changing it makes Protect see a new camera. |
| `ptz` | `false` | Advertise the PTZ service and forward PTZ commands. |
| `imaging` | `true` | Advertise the imaging service. Set `false` if the target rejects imaging calls. |
| `events` | `true` | Advertise the events service. Set `false` and Protect won't subscribe at all. |
| `target.hostname` | required | IP of the real camera, or of the NVR. |
| `target.ports.rtsp` | | RTSP port on the target, usually 554. The proxy only forwards RTSP when this and `ports.rtsp` are both set. |
| `target.ports.snapshot` | `80` | HTTP port on the target. Snapshots go here, and so do the forwarded events, PTZ and imaging calls, so it has to be a port that answers ONVIF too. |
| `target.tokens.main` | `Profile_1` | The target's ONVIF profile token for the main stream. PTZ commands use it. |
| `target.tokens.sub` | `Profile_2` | The target's profile token for the sub stream. |
| `target.tokens.videoSource` | `VideoSource_1` | The target's video source token, used by imaging. Setting it explicitly also filters motion events down to that source; see below. |
| `target.reolink.channel` | | Reolink NVR channel number. On a PTZ camera this sends moves through Reolink's own API instead of ONVIF. Needs the `REOLINK_*` variables. |
| `highQuality.rtsp` | required | RTSP path of the main stream on the target. |
| `highQuality.snapshot` | | Snapshot path on the target. Without it Protect gets a placeholder image. |
| `highQuality.width`, `height`, `framerate`, `bitrate`, `quality` | required | What the proxy tells Protect about the main stream. Match the camera's real settings; the proxy doesn't transcode. |
| `lowQuality` | | Same fields for the sub stream. Leave it out and the camera only offers one stream. |
| `ports.server` | required | Port the virtual camera's ONVIF service listens on. |
| `ports.rtsp`, `ports.snapshot` | required | Ports the virtual camera forwards to the target's RTSP and snapshot ports. These listen on every address the process has, so in a shared network namespace each target host needs its own pair. In per-camera containers they can repeat. |

### Environment variables

| Variable | What it does |
|---|---|
| `DEBUG` | Any value turns on trace logging, including every ONVIF request and response. Useful while adopting, noisy after. |
| `REOLINK_USERNAME`, `REOLINK_PASSWORD` | NVR login for cameras with `target.reolink`. Nothing else uses them. |

### Credentials

You enter the camera's username and password in Protect when you adopt it. The proxy stores neither: Protect signs every ONVIF request with them, and the proxy forwards that signature to the camera untouched, so the camera checks its own password. RTSP and snapshot logins pass through the same way.

The one exception is Reolink PTZ. Reolink's PTZ API needs a real login rather than a forwarded signature, so cameras with `target.reolink` read one from `REOLINK_USERNAME` and `REOLINK_PASSWORD`. Keep those in your secret store, not in the config file.

## Hikvision and Luma

These work with the defaults. Use the camera's `/Streaming/Channels/101/` (main) and `/102/` (sub) paths, and `/ISAPI/Streaming/Channels/101/picture` for snapshots. Set `ptz: true` on PTZ models.

## Reolink NVRs

An NVR puts all of its channels behind one ONVIF endpoint, so each virtual camera has to point at its own channel. This was built against an RLN16-410 (hardware N6MB01, firmware v3.6.5.562). Other Reolink NVRs likely behave the same, but that's untested.

Here's channel 6 of a 4K PTZ camera:

```yaml
  - name: HangarPTZ
    dev: eth0
    ptz: true
    imaging: false
    events: false
    target:
      hostname: 192.168.1.193
      ports:
        rtsp: 554
        snapshot: 80
      tokens:
        main: "060"
        sub: "061"
        videoSource: "006"
      reolink:
        channel: 6
    highQuality:
      rtsp: /Preview_07_main
      snapshot: /cgi-bin/api.cgi?cmd=onvifSnapPic&channel=6
      width: 3840
      height: 2160
      framerate: 25
      bitrate: 6144
      quality: 4
    lowQuality:
      rtsp: /Preview_07_sub
      snapshot: /cgi-bin/api.cgi?cmd=onvifSnapPic&channel=6
      width: 896
      height: 512
      framerate: 20
      bitrate: 1024
      quality: 1
    ports:
      server: 8081
      rtsp: 8554
      snapshot: 8580
```

Channel numbers start at 0, but the RTSP paths start at 1, so channel 6 is `Preview_07`. The ONVIF tokens follow the channel: profiles are `0N0` and `0N1` and the video source is `00N`, so channel 6 is `060`, `061` and `006`, and channel 10 is `100`, `101` and `010`.

Some things about these NVRs that took a while to find:

- Turn on HTTP (port 80) under the NVR's network server settings. With it off, port 80 redirects everything to HTTPS and the ONVIF port (8000) doesn't serve snapshots. With it on, port 80 answers both snapshots and ONVIF, which is why `target.ports.snapshot` is 80.
- ONVIF PTZ doesn't work through the NVR. It answers `ContinuousMove` and `Stop` with success and never moves the camera, whichever endpoint, axis or velocity format you use. Reolink's own `PtzCtrl` API does move it. So with `target.reolink.channel` set, the proxy turns Protect's moves into `PtzCtrl` calls. Direction comes from the signs of the velocity, diagonals included. Zoom becomes `ZoomInc` or `ZoomDec`, and the speed scales to Reolink's 1 to 64. Other PTZ calls still go over ONVIF.
- Imaging calls fault for every channel, hence `imaging: false`.
- The NVR allows only 2 event subscriptions in total, across all channels. The proxy opens one upstream subscription per Protect subscription per camera, so with more than a couple of cameras they push each other out and Protect gets constant 400 errors. Keep `events: false` until the proxy shares one subscription across cameras. The per-camera filtering for that is already in place: with `target.tokens.videoSource` set, the proxy drops events from other channels.
- The NVR rejects event pulls that lack a WS-Addressing `To` header. The proxy rewrites `To` to the NVR's address when the client sends one, but Protect doesn't send it, so adding a missing header is part of the unfinished events work.
- On this NVR the 4K cameras' main streams are H.265 only, with no 1080p or H.264 option. The proxy implements ONVIF Media 1, which has no way to say H.265, so it labels the stream H.264, as the NVR's own Media 1 service does. The video passes through untouched; a browser without H.265 support may not play it.

## Other brands

The defaults assume Hikvision's ONVIF tokens. For anything else, ask the camera what its tokens are with any ONVIF client: `GetProfiles` gives the profile tokens (`target.tokens.main` and `sub`), and `GetVideoSources` gives the video source token. Put those in `target.tokens`. If PTZ or imaging then fails with `ter:InvalidArgVal` or `ter:NoProfile`, the tokens are still wrong.

If you get it working on another brand, an issue saying which tokens it needed would help the next person.

## Things worth knowing

- The ONVIF WSDLs and every schema they import ship in `wsdl/vendor/`, so the proxy needs no internet access to start. Older versions downloaded them from onvif.org and w3.org at startup, and broke when w3.org started answering those downloads with 403.
- Each Protect subscription becomes its own upstream subscription, capped at 32 per camera. Luma cameras allow 10, so a single Protect is fine. Running Protect, Frigate and Scrypted against the same proxy uses up camera slots one-for-one.
- PTZ isn't auto-detected. Detecting it would mean either storing credentials or reworking how the device service is bound, so it's the `ptz` flag instead.
- `GetVideoEncoderConfigurationOptions` reports exactly the configured resolution and frame rate, since the proxy can't change the camera's encoder.

## Tested with

- Luma LUM-310-DOM-IP-BL ×4 (Hikvision OEM, firmware V5.5.52), LUM-310-PTZ-IP-WH and LUM-510-PTZ-IP-WH (V5.5.6). systemd on a Raspberry Pi 4, Ubuntu 24.04, Node 22.
- Reolink RLN16-410 NVR with 11 cameras, 2 of them PTZ. One container per camera on an Orange Pi 5 (RK3588), Docker 29.
- UDM running UniFi Protect 7.1.60.

On the Pi 4 with six cameras (measured on Node 18), the process sat around 380 MB of memory and 65% of one core, most of it the RTSP forwarding. Hardware smaller than a Pi 4 is untested.

Not tested: smart detection topics (person, vehicle and so on, which pass through if the camera sends them), Protect versions other than 7.1.60, and other brands.

## Credits

Daniela Hase wrote the original virtual ONVIF server. Piotr Kula (p10tyr) turned it into a Docker appliance with automatic MAC and IP setup, and is upstream of this fork.
