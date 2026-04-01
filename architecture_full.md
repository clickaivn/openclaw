# ClickBot Production Architecture

## Full System Architecture

```mermaid
graph TB
    subgraph USER["👤 User Browser"]
        EXT["🧩 Chrome Extension<br/><i>ClickBot V3</i><br/>clawbot-inject.js"]
        MIC["🎤 Mic Bridge<br/><i>mic-bridge-live.html</i>"]
    end

    subgraph SERVER["🖥️ Production Server (Docker)"]
        subgraph NET["clickbot-net (Docker Network)"]
            GW["⚡ OpenClaw Gateway<br/>Port 18789<br/><i>Node.js — Agent Runtime</i>"]
            ADMIN["📊 Admin Server<br/>Port 3456<br/><i>Node.js — Dashboard + API</i>"]
            VOICE["🔊 Live Voice Server<br/>Port 3457<br/><i>Python — WebSocket Proxy</i>"]
            BACKUP["💾 Backup Cron<br/><i>Alpine — Daily tar.gz</i>"]
        end

        subgraph STORAGE["Persistent Storage"]
            V1[("📁 openclaw-data<br/><b>Shared Volume</b><br/>• openclaw.json<br/>• agents/sessions/*.jsonl<br/>• workspaces/*/SOUL.md<br/>• auth-profiles.json")]
            V2[("📁 admin-data<br/><b>Admin Volume</b><br/>• admin.db (SQLite)<br/>• default-soul.md<br/>• credentials/")]
            V3["📂 ./backups/<br/><i>Host bind mount</i><br/>• clickbot_*.tar.gz"]
        end
    end

    EXT -->|"WebSocket :18789<br/>chat.send / chat events<br/>browser-action blocks"| GW
    EXT -->|"HTTP :3456<br/>/api/me, /api/model-switch<br/>Agent settings"| ADMIN
    MIC -->|"WebSocket :3457<br/>Audio stream"| VOICE
    EXT -.->|"Opens in iframe"| MIC

    ADMIN -->|"WS internal<br/>ws://clickbot-gateway:18789<br/>secrets.reload, config sync"| GW

    GW -->|"R/W"| V1
    ADMIN -->|"R/W"| V1
    ADMIN -->|"R/W"| V2
    BACKUP -->|"Read-only"| V1
    BACKUP -->|"Read-only"| V2
    BACKUP -->|"Write"| V3

    classDef user fill:#e8f5e9,stroke:#4caf50,stroke-width:2px,color:#1b5e20
    classDef gateway fill:#e3f2fd,stroke:#1976d2,stroke-width:2px,color:#0d47a1
    classDef admin fill:#fce4ec,stroke:#e91e63,stroke-width:2px,color:#880e4f
    classDef voice fill:#fff3e0,stroke:#ff9800,stroke-width:2px,color:#e65100
    classDef backup fill:#f3e5f5,stroke:#9c27b0,stroke-width:1px,color:#4a148c
    classDef storage fill:#fffde7,stroke:#fbc02d,stroke-width:1px,color:#f57f17

    class EXT,MIC user
    class GW gateway
    class ADMIN admin
    class VOICE voice
    class BACKUP backup
    class V1,V2,V3 storage
```

## Data Flow Details

```mermaid
sequenceDiagram
    participant EXT as 🧩 Extension
    participant GW as ⚡ Gateway :18789
    participant ADMIN as 📊 Admin :3456
    participant VOICE as 🔊 Voice :3457
    participant VOL as 📁 openclaw-data

    Note over EXT: User opens Chrome

    EXT->>ADMIN: GET /api/me (login)
    ADMIN-->>EXT: {agentId, email, providers}

    EXT->>GW: WebSocket connect
    GW->>VOL: Load SOUL.md + agent config
    GW-->>EXT: Connected ✅

    Note over EXT: User sends message

    EXT->>GW: chat.send {sessionKey, message}
    GW->>VOL: Read SOUL.md (system prompt)
    GW->>GW: LLM API call (DeepSeek/Gemini)
    GW-->>EXT: chat {state:delta} (streaming)
    GW-->>EXT: chat {state:final, browser-action}
    EXT->>EXT: Parse & execute browser-action

    Note over EXT: User switches model

    EXT->>ADMIN: POST /api/model-switch
    ADMIN->>VOL: Update openclaw.json
    ADMIN->>GW: WS secrets.reload
    GW->>VOL: Re-read config
    GW-->>ADMIN: ✅ reload complete

    Note over EXT: User uses voice

    EXT->>VOICE: WebSocket (audio stream)
    VOICE-->>EXT: Transcribed text
    EXT->>GW: chat.send {voice message}
```

## Port Map

| Port | Service | Protocol | Exposed To |
|------|---------|----------|------------|
| **18789** | Gateway | WebSocket | Extension (external) |
| **3456** | Admin | HTTP | Extension + Browser (external) |
| **3457** | Live Voice | HTTP + WS | Extension iframe (external) |

## Volume Map

| Volume | Containers | Access | Contents |
|--------|-----------|--------|----------|
| `openclaw-data` | Gateway + Admin + Backup | RW / RO | Agent data, sessions, SOUL.md, configs |
| `admin-data` | Admin + Backup | RW / RO | SQLite DB, credentials, templates |
| `./backups/` | Backup only | Write | Daily compressed backups |
