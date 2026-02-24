# RetroCast 🎬📺

Retro TV Guide for Plex — Docker container.  
Self-contained: Node.js and ffmpeg are bundled inside the image.  
The host machine only needs **Docker Desktop**.

---

## Prerequisites (Windows)

1. [Docker Desktop for Windows](https://www.docker.com/products/docker-desktop) — enable WSL2 backend during install
2. Standard NVIDIA drivers (the ones you already use for gaming/work) — no extra toolkit needed on Windows

---

## Option A — Run from GitHub Container Registry (recommended)

Once you push this repo to GitHub, the image builds automatically.

```bash
# Pull and run
docker compose up -d
```

Open **http://localhost:3000**

---

## Option B — Build locally

```bash
docker compose up -d --build
```

---

## Deploying via Portainer

1. **Portainer → Stacks → Add Stack**
2. Name it `retrocast`
3. Paste the contents of `docker-compose.yml`
4. Edit the `image:` line to your GHCR address:
   ```
   image: ghcr.io/YOUR_USERNAME/retrocast:latest
   ```
5. **Deploy the stack**

To update after a code push: Portainer → Stacks → retrocast → **Pull and redeploy**  
Your data volume is never touched during updates.

---

## GPU Setup

### NVIDIA on Windows (your setup)

1. Set `ENCODER: nvidia` in `docker-compose.yml`
2. Uncomment the NVIDIA `deploy:` block
3. That's it — Docker Desktop passes the GPU through automatically

Verify after starting:
```bash
docker exec retrocast nvidia-smi
```

Container logs on startup will confirm:
```
Encoder: NVIDIA NVENC (h264_nvenc)
Encoder mode: forced → nvidia
```

### Intel / AMD on Linux

See the comments in `docker-compose.yml` — requires `/dev/dri` device passthrough and a one-time group membership change on the host.

### CPU only (no GPU)

Set `ENCODER: cpu` — works everywhere, no passthrough needed. Slower for HD content.

---

## Publishing to GitHub (so Portainer can pull it)

```bash
git init
git remote add origin https://github.com/YOUR_USERNAME/retrocast.git
git add .
git commit -m "Initial commit"
git push -u origin main
```

GitHub Actions builds `ghcr.io/YOUR_USERNAME/retrocast:latest` automatically on every push.

To make the package publicly pullable (easier for Portainer):  
GitHub → your repo → **Packages** → `retrocast` → **Package settings** → **Change visibility → Public**

---

## Environment Variables

| Variable    | Default                      | Description                              |
|-------------|------------------------------|------------------------------------------|
| `PORT`      | `3000`                       | HTTP port                                |
| `DATA_FILE` | `/data/retrocast-data.json`  | Persistent data path (inside container)  |
| `ENCODER`   | `auto`                       | GPU encoder: auto / nvidia / intel / amd / cpu |

---

## Data & Backups

All data lives in the `retrocast-data` Docker volume at `/data/retrocast-data.json`.

Backup:
```bash
docker run --rm -v retrocast-data:/data -v "%cd%":/backup alpine \
  tar czf /backup/retrocast-backup.tar.gz /data
```

Restore:
```bash
docker run --rm -v retrocast-data:/data -v "%cd%":/backup alpine \
  tar xzf /backup/retrocast-backup.tar.gz -C /
```
