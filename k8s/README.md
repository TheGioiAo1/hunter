# k8s — Machine 2 deployment manifests

Manifest cho cluster MicroK8s trên Machine 2 (`192.168.1.24`) connect DB MongoDB + Redis nằm ở Machine 1 (`192.168.1.19`).

## Files

| File | Purpose |
|---|---|
| `00-namespace.yaml` | Namespace `gbox-fe` |
| `01-external-services.yaml` | Service + Endpoints để pod resolve `mongodb` / `redis` DNS → IP Machine 1 NodePort |
| `02-db-secrets-template.yaml` | TEMPLATE THAM KHẢO — KHÔNG apply trực tiếp (chứa placeholder password) |
| `03-smoke-test-mongo.yaml` | Job test connect Mongo + insert/find |
| `04-smoke-test-redis.yaml` | Job test PING + SET/GET Redis |
| `bootstrap-machine2.sh` | All-in-one: namespace + services + secret + smoke tests |

## Flow trên Machine 2

```bash
# 1. Clone repo (chỉ lần đầu)
git clone https://github.com/TheGioiAo1/hunter.git /srv/hunter
cd /srv/hunter/k8s

# 2. Lấy 2 password từ Machine 1 (SSH sang Machine 1):
ssh root@192.168.1.19 "
  microk8s kubectl get secret -n gbox-db mongo-secrets \
    -o jsonpath='{.data.GBOX_MONGO_USER_PASSWORD}' | base64 -d
  echo
  microk8s kubectl get secret -n gbox-db redis-secrets \
    -o jsonpath='{.data.REDIS_PASSWORD}' | base64 -d
  echo
"

# 3. Export credentials (KHÔNG paste vào git, chỉ trong shell session):
export GBOX_MONGO_PASS='<mongo-password-paste-here>'
export GBOX_REDIS_PASS='<redis-password-paste-here>'

# 4. Run bootstrap
chmod +x bootstrap-machine2.sh
./bootstrap-machine2.sh

# 5. Verify (output expected):
#   smoke-mongo: insertOne/find OK
#   smoke-redis: PONG + SET/GET OK
```

## DNS in-cluster

Sau khi bootstrap, pod trong namespace `gbox-fe` có thể connect:

```
mongodb://gbox:<pass>@mongodb:27017/Gbox-Users?authSource=Gbox-Users
redis://default:<pass>@redis:6379/0
```

Service `mongodb` và `redis` resolve về `192.168.1.19:30017` / `192.168.1.19:30379` qua Endpoints object — KHÔNG hardcode IP trong app code.

## Update credentials (rotation)

```bash
# Mongo: đổi password ở Machine 1 (kubectl edit secret -n gbox-db mongo-secrets)
# Sau đó lặp lại bước 2-4 của Flow trên Machine 2 — script delete + recreate secret.
```

## Cleanup

```bash
microk8s kubectl delete namespace gbox-fe
```

## Open follow-ups

- FE codebase chưa refactor Postgres → Mongo. Sau khi refactor xong, thêm `Deployment` + `Service` + `Ingress` cho 6 apps (accounts, god-admin, store-admin, storefront, checkout, supporter) vào `k8s/`.
- cert-manager + Let's Encrypt cho `*.huntershop.us` — chưa làm.
- Backup Mongo từ Machine 1 → object storage — chưa làm.
