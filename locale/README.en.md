# Remote Over Tailnet

`dsh-remote-over-tailnet` (abbreviated ROT in the docs) is a host plugin for DeepSeek Harness Desktop on Windows. It embeds a WebAssembly build of the Tailscale node inside the plugin, joins the tailnet with it, and lets a DSH Remote client on the same tailnet reach the sessions running on this computer with streaming output. DSH Go is one Android client.

## Features

- Ships its own Tailscale node, so the computer needs no system Tailscale install, no public IP, no port forwarding, and no third-party relay.
- Starts a local relay on a loopback address and lets the embedded node listen inside the tailnet and forward to it.
- Shows the DSH Remote server address, account, and password in the plugin panel, with status for the embedded node, relay, tailnet listener, and host authorization.
- Connects to the already-running DeepSeek Harness Desktop session with streaming output; the client is not modified.

## Get started

1. Install and enable ROT in DeepSeek Harness Desktop, then restart Desktop.
2. Open Plugins → Remote Over Tailnet → Remote settings and turn on the switch at the right of the "DSH Remote local relay service" row.
3. The panel shows an authorization link the first time. Open it, sign in to the tailnet, and approve the node; setting `tailnet.authKey` skips this step.
4. Add a custom server in a DSH Remote client (for example DSH Go) with the address and credentials shown in the panel.

Requirements: client device and computer on the same tailnet, with Tailscale online on the client device.

This is a fork of the MIT project ds-harness-remote and is not affiliated with Tailscale Inc. or DeepSeek.
