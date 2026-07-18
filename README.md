# strava-heatmap-proxy

_A personal fork of [erik/strava-heatmap-proxy](https://github.com/erik/strava-heatmap-proxy),
adding a shared-key access gate and cookie-refresh hardening. For personal use
with your own Strava account._

This is a simple [Cloudflare Worker](https://workers.dev) that gives map clients
a plain tile URL for personal and global Strava heatmaps. It handles Strava's
own authentication for you — exchanging your session cookie for the short-lived
CloudFront credentials the tiles require — so apps like Gaia or Locus don't have
to. The personal heatmap is only served to an authenticated Strava session (see
the note below); the global heatmap works for any account.

Note: you **will** need to be a Strava premium subscriber to use the personal
heatmap, while the global heatmaps are available to all Strava accounts.
Personal use only, please. Strava will ratelimit you.

> **This fork gates tile access behind a `PROXY_KEY`.** Every tile request must
> carry `?key=<your key>`, so the deployed URL isn't an open proxy on your
> Strava account for anyone who finds the hostname. See [Secrets](#secrets).

# Usage

If you want to use these heatmaps as a tile layer in another app, here are the
template URLs to use:

- Personal: `https://strava-heatmap-proxy.YOUR_NAMESPACE.workers.dev/personal/orange/all/{zoom}/{x}/{y}@2x.png?key=YOUR_PROXY_KEY`
- Global: `https://strava-heatmap-proxy.YOUR_NAMESPACE.workers.dev/global/orange/all/{zoom}/{x}/{y}@2x.png?key=YOUR_PROXY_KEY`

Check `https://strava-heatmap-proxy.YOUR_NAMESPACE.workers.dev/` for full list
of supported tile colors, activities, and sizes.

# Deploying the proxy

Requirements:

- [wrangler](https://github.com/cloudflare/wrangler) to manage Worker
  deployments

### Strava Credentials

Strava's API doesn't support heatmap access directly, so we'll need to
grab a session cookie from the browser for authentication.

1. Open https://strava.com/maps in your browser
2. Using devtools, find the `_strava4_session` cookie for `strava.com`

We also need your account id. You can find this by clicking on "My Profile"
on the Strava website and taking note of the URL:
`https://www.strava.com/athletes/{strava_id}`.

### Secrets

```bash
wrangler login

# The worker uses a KV namespace to cache CloudFront cookies and keep them up to
# date.
#
# Make sure to update wrangler.toml with the ID you get back.
wrangler kv namespace create STRAVA_HEATMAP_PROXY_COOKIES

echo "1234" | wrangler secret put STRAVA_ID
echo "abc123..." | wrangler secret put STRAVA_SESSION

# Tile access is gated by a shared key — without it the worker refuses every
# tile request (fails closed). Generate one, note it (it goes in your tile
# URLs as ?key=...), and set it as a secret.
openssl rand -hex 32           # copy the output
wrangler secret put PROXY_KEY  # paste it when prompted
```

The worker will automatically exchange your session cookie for CloudFront
credentials and refresh them as they expire.

You'll need to update `STRAVA_SESSION` if your session cookie ever expires
though.

### Verify

Check that everything's working by running `wrangler dev`.

Here's an example tile URL with some data:
[/global/mobileblue/all/11/351/817@2x.png?key=YOUR_PROXY_KEY](http://127.0.0.1:8787/global/mobileblue/all/11/351/817@2x.png?key=YOUR_PROXY_KEY)
(Downtown Los Angeles). Set `PROXY_KEY` in a local `.dev.vars` file so the gate
lets the request through; without it the worker fails closed.

When you're all set, use `wrangler deploy` to bring the site live on
`strava-heatmap-proxy.YOUR-NAMESPACE.workers.dev`

## (optional) GitHub Actions

Start by forking this repository and setting up some GitHub secrets
(`github.com/you/strava-heatmap-proxy/settings/secrets/actions`).

- [`CF_ACCOUNT_ID`](https://developers.cloudflare.com/fundamentals/get-started/basic-tasks/find-account-and-zone-ids/)
- [`CF_API_TOKEN`](https://developers.cloudflare.com/fundamentals/api/get-started/create-token/)
- `KV_NAMESPACE_ID`: ID of the `STRAVA_HEATMAP_PROXY_COOKIES` KV store (see above)

These secrets will be used by GitHub Actions:

1. [deploy.yml](.github/workflows/deploy.yml): Deploy to Cloudflare on every
   commit to `main`.

Trigger the action for your first deploy, and you should be good to
go. Your site should now be live on
`strava-heatmap-proxy.YOUR-NAMESPACE.workers.dev`.
