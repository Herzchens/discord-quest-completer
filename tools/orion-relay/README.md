# Orion Relay

A tiny localhost HTTP relay that unlocks the `ACHIEVEMENT_IN_ACTIVITY` auto-bypass for the standalone userscript on Discord Desktop. **No Vencord, no BetterDiscord, no client mod required**.

## Why this exists

Discord's renderer CSP (`connect-src` allowlist) blocks `fetch()` to `*.discordsays.com` from the userscript:

```
Refused to connect to 'https://{appId}.discordsays.com/.proxy/acf/authorize'
because it violates the following Content Security Policy directive: "connect-src 'self' ..."
```

The allowlist **does** include `http://127.0.0.1:*` (Discord uses this for RPC with games). So the userscript can talk to a relay running on `127.0.0.1`, and the relay (running outside the browser sandbox) can talk to `discordsays.com` freely.

That's the entire trick.

## Install / run

### Windows

1. Download `orion-relay.ps1` and `start-relay.cmd` from this folder into the same directory (e.g. `C:\Tools\orion-relay\`).
2. Double-click `start-relay.cmd`. A console window opens:
   ```
   ==========================================
    Orion Relay listening on http://127.0.0.1:43210/
    Paste the userscript in Discord DevTools.
    Keep this window open. Ctrl+C to stop.
   ==========================================
   ```
3. Leave it open. Paste the userscript into Discord's DevTools console as usual. It'll detect the relay automatically.
4. Done. Close the window with Ctrl+C or the X button when you're done.

### Linux / macOS (and from-source)

The relay is a 100-line PowerShell script. PowerShell 7+ runs on Linux/macOS, so install it via your package manager, then:

```sh
pwsh ./orion-relay.ps1
```

If you'd rather not install PowerShell, use the bundled Python port. It needs
only the Python 3 standard library, so no `pip install`:

```sh
python3 ./orion-relay.py
```

Same wire protocol, same security posture (loopback-only bind, host allowlist,
path allowlist, header allowlist, no redirect following, 64 KB body cap). Prefer
Node? The wire protocol below is trivial to reimplement.

## Wire protocol

The userscript talks to the relay over plain HTTP. Two endpoints:

### `GET /health`
Probe to confirm the relay is running. Returns 200 with `{"ok":true,"name":"orion-relay","version":"1"}`.

### `POST /proxy`
Forward a request to `*.discordsays.com`. Body:

```json
{
  "url": "https://1495767543946809424.discordsays.com/.proxy/acf/authorize",
  "headers": {
    "Content-Type": "application/json",
    "X-Auth-Token": "",
    "X-Discord-Quest-ID": "1511073863214170153",
    "Referer": "https://1495767543946809424.discordsays.com/?instance_id=..."
  },
  "body": "{\"code\":\"AUTH_CODE_HERE\"}"
}
```

Response:

```json
{ "ok": true, "status": 200, "body": "{\"token\":\"DS_TOKEN\"}" }
```

## Security

- Listens only on `127.0.0.1`, so it is not reachable from other machines on your network.
- Whitelists upstream hosts to `^[0-9]+\.discordsays\.com$` and the two `acf` paths the bypass uses. Won't forward to arbitrary URLs, and won't follow a redirect off that list.
- Rejects a request whose `Host` header isn't `127.0.0.1:43210`, which is what a DNS-rebinding attack looks like.
- Drops every header except the six the bypass needs, so a caller can't smuggle a `Cookie` upstream.
- Requires the header `X-Orion-Relay: 1` on `/proxy`, and reflects `Access-Control-Allow-Origin` only back to `discord.com`. Together those mean a web page you happen to have open cannot drive the relay: a custom header forces the browser through a CORS preflight, and the preflight only answers Discord. **This was a real hole before v4.11.3** — withholding the CORS header stopped another site reading the reply, but a page could still send the request as `text/plain`, which skips the preflight entirely, and the relay forwarded it. Update the relay when you update the userscript; `tools/tests/relay-regression.py` is the check.
- No credentials are stored or logged. The console line shows the upstream path and host, never the token.
- The script source is short, so read it before you run it.

That said: any *program* on your machine can still POST to `http://127.0.0.1:43210/proxy` while the relay is running, since it can set the header too. The header is a CORS forcing function, not authentication. The host and path allowlist is what limits the damage, and local code that hostile has already beaten you anyway. Stop the relay between sessions if you'd rather not leave the port open.
