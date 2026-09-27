"""Xero access for Step 5 (FY24/25+ coding proposals) — chart of accounts + coding history.

Reuses the SAME live connection row the orchestrator already has (tenant bdde9f4c-..., the real
Global Buildtech Australia Pty Ltd org), read via the Supabase Management API exactly as done
manually earlier this session. Mirrors src/connectors/xero.ts's accessTokenFor() precisely:
Xero access tokens last 30 minutes AND REFRESH TOKENS ROTATE ON EVERY USE — the old one is dead
the instant the new one is issued. The refreshed pair is persisted back to the SAME `connections`
row this tool shares with the (currently paused) orchestrator, immediately, before use. A failed
persist is fatal, not logged-and-continued — a rotated token we didn't save is a connection we
already lost.

Needs XERO_CLIENT_ID / XERO_CLIENT_SECRET as environment variables. Never hardcode, never commit.
"""

import json
import os
import subprocess
import urllib.parse
import urllib.request
from dataclasses import dataclass

SUPABASE_PROJECT_REF = "xuzvurmprexhalnxgsdu"
XERO_TOKEN_URL = "https://identity.xero.com/connect/token"
XERO_API = "https://api.xero.com/api.xro/2.0"


def _supabase_query(sql: str):
    """Same Supabase Management API pattern used manually all session — no new dependency."""
    with open(os.path.expanduser("~/.supabase-token")) as f:
        token = f.read().strip()
    req = urllib.request.Request(
        f"https://api.supabase.com/v1/projects/{SUPABASE_PROJECT_REF}/database/query",
        data=json.dumps({"query": sql}).encode(),
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req) as resp:
        return json.loads(resp.read())


@dataclass
class XeroConnection:
    id: str
    provider_org_id: str
    access_token: str
    refresh_token: str


def connection_for(tenant_id: str) -> XeroConnection:
    rows = _supabase_query(
        f"select id, provider_org_id, access_token, refresh_token from connections "
        f"where tenant_id = '{tenant_id}' and provider = 'xero' and revoked_at is null;"
    )
    if not rows:
        raise RuntimeError(f"no live Xero connection for tenant {tenant_id}")
    return XeroConnection(**rows[0])


def access_token_for(conn: XeroConnection) -> str:
    """Always refreshes — this tool runs occasionally, not continuously, so the 30-minute access
    token is essentially always stale by the time it's used. Refreshing every call is simpler and
    safer than tracking expires_at locally and risking a stale in-memory copy."""
    client_id = os.environ.get("XERO_CLIENT_ID")
    client_secret = os.environ.get("XERO_CLIENT_SECRET")
    if not client_id or not client_secret:
        raise RuntimeError(
            "XERO_CLIENT_ID / XERO_CLIENT_SECRET must be set as environment variables to refresh "
            "the Xero connection. Never commit these — export them in the shell running this tool."
        )

    import base64

    basic = base64.b64encode(f"{client_id}:{client_secret}".encode()).decode()
    body = urllib.parse.urlencode(
        {"grant_type": "refresh_token", "refresh_token": conn.refresh_token}
    ).encode()
    req = urllib.request.Request(
        XERO_TOKEN_URL,
        data=body,
        headers={
            "Authorization": f"Basic {basic}",
            "Content-Type": "application/x-www-form-urlencoded",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req) as resp:
            tok = json.loads(resp.read())
    except urllib.error.HTTPError as e:
        detail = e.read().decode()[:200]
        raise RuntimeError(f"Xero refresh failed ({e.code}): {detail}")

    # Persist the rotated pair IMMEDIATELY, before returning it for use — matching xero.ts exactly.
    escaped_access = tok["access_token"].replace("'", "''")
    escaped_refresh = tok["refresh_token"].replace("'", "''")
    result = _supabase_query(
        f"update connections set access_token = '{escaped_access}', "
        f"refresh_token = '{escaped_refresh}', "
        f"expires_at = now() + interval '{tok['expires_in']} seconds', last_error = null "
        f"where id = '{conn.id}' returning id;"
    )
    if not result:
        raise RuntimeError(
            "Xero token rotated but could not be saved — this connection is now lost. "
            "Do not retry blindly; check the connections row directly first."
        )
    return tok["access_token"]


def xero_get(path: str, access_token: str, org_tenant_id: str):
    req = urllib.request.Request(
        f"{XERO_API}{path}",
        headers={
            "Authorization": f"Bearer {access_token}",
            "Xero-tenant-id": org_tenant_id,
            "Accept": "application/json",
        },
    )
    with urllib.request.urlopen(req) as resp:
        return json.loads(resp.read())
