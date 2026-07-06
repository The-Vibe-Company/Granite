# Direct multi-device sync

Granite sync is direct machine-to-machine. Run it over LAN, Tailscale, or a private DNS name; there is no relay, hosted worker, billing tier, or cloud authority.

## Setting up

Grant access per device, then serve the vault:

```bash
# Machine A (the vault you sync against)
granite sync access grant ipad --role read
granite sync access grant desktop --role write
granite sync serve --host 0.0.0.0 --port 8765
```

Each grant produces a token scoped to a role. Inspect and revoke them anytime:

```bash
granite sync access list
granite sync access revoke ipad
```

## Syncing from other machines

```bash
# Read-only Machine B
granite sync remote add macbook http://100.x.y.z:8765 --token <read-token>
granite sync pull macbook
granite sync watch macbook --direction pull --interval 30

# Write-capable Machine C
granite sync remote add macbook http://100.x.y.z:8765 --token <write-token>
granite sync run macbook        # pull then push
granite sync watch macbook --interval 30
```

`granite sync status` shows the device identity, policy, and configured remotes. `granite sync remote list` / `remove` manage remotes.

## Conflict resolution

Conflicts default to manual preservation with `.conflict.<device>.<timestamp>.md` files. For a personal multi-device setup, pick the device that wins conflicts:

```bash
granite sync config --policy primary-wins --primary-this-device
```

## Read-only MCP for synced vaults

MCP is scoped to one vault per server. Launch a read-only MCP server when an agent should inspect a synced vault without mutating it:

```bash
granite mcp --vault ~/.granite --role read
```

Use `--role write` (the default) only on the machine where the agent is allowed to mutate the vault.

## Security notes

- Sync speaks plain HTTP and authenticates with bearer tokens. Only run it over a network you trust: a home LAN, Tailscale, or another private overlay. Crossing an untrusted boundary requires a TLS tunnel or reverse proxy in front of `granite sync serve` — and in that setup, bind the backend to loopback (`granite sync serve --host 127.0.0.1`) so only the proxy can reach it.
- `--host 0.0.0.0` exposes the sync server on every interface. Bind to a specific private address (e.g. your Tailscale IP) when in doubt.
- Treat write-scoped tokens like passwords: anyone holding one can mutate the vault. Revoke tokens you no longer use with `granite sync access revoke <name>`.
