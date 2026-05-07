# Kubernetes

Reference for pro coders shipping to K8s. Not for vibe coders — if you can avoid K8s (VPS + Compose, Vercel, Cloudflare, managed runtimes), do. Only reach for K8s when you actually need: horizontal autoscaling across many nodes, multi-service orchestration at scale, or org mandates it.

Assumes `kubectl` is configured (`kubectl config current-context` shows the right cluster).

## Core objects

| Kind | Purpose |
|------|---------|
| **Pod** | Smallest unit — 1+ containers sharing network/storage. Rarely created directly. |
| **Deployment** | Manages a set of identical Pods + rolling updates. Default for stateless services. |
| **StatefulSet** | Deployment for stateful workloads — stable hostnames, persistent volumes. Use for DBs. |
| **Service** | Stable network endpoint fronting Pods. Types: `ClusterIP` (internal), `NodePort`, `LoadBalancer`. |
| **Ingress** | HTTP(S) routing rules (host + path → Service). Requires an Ingress Controller (nginx, traefik). |
| **ConfigMap** | Non-secret config key-value. Mounted as env vars or files. |
| **Secret** | Sensitive config — base64-encoded by default (NOT encrypted at rest unless cluster configured). Use SealedSecrets or external-secrets-operator for git-ops. |
| **PersistentVolumeClaim** | Request for storage. Bound to a PersistentVolume by the cluster. |
| **Namespace** | Logical isolation. Use one per env (dev/staging/prod) or per team. |
| **Job / CronJob** | One-off / scheduled task. |

## Minimum viable manifests

`k8s/deployment.yaml`:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: web
  namespace: app
  labels: { app: web }
spec:
  replicas: 3
  selector:
    matchLabels: { app: web }
  template:
    metadata:
      labels: { app: web }
    spec:
      containers:
        - name: web
          image: ghcr.io/<owner>/<repo>:sha-abc123    # pin immutable tag
          ports:
            - containerPort: 3000
          env:
            - name: DATABASE_URL
              valueFrom:
                secretKeyRef: { name: web-secrets, key: database-url }
          envFrom:
            - configMapRef: { name: web-config }
          resources:
            requests: { cpu: 100m, memory: 128Mi }
            limits:   { cpu: 500m, memory: 512Mi }
          readinessProbe:
            httpGet: { path: /health, port: 3000 }
            initialDelaySeconds: 5
            periodSeconds: 10
          livenessProbe:
            httpGet: { path: /health, port: 3000 }
            initialDelaySeconds: 30
            periodSeconds: 30
          securityContext:
            runAsNonRoot: true
            runAsUser: 1001
            allowPrivilegeEscalation: false
            readOnlyRootFilesystem: true
            capabilities: { drop: [ALL] }
```

`k8s/service.yaml`:

```yaml
apiVersion: v1
kind: Service
metadata:
  name: web
  namespace: app
spec:
  selector: { app: web }
  ports:
    - port: 80
      targetPort: 3000
  type: ClusterIP
```

`k8s/ingress.yaml`:

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: web
  namespace: app
  annotations:
    cert-manager.io/cluster-issuer: letsencrypt-prod
spec:
  ingressClassName: nginx
  tls:
    - hosts: [app.example.com]
      secretName: web-tls
  rules:
    - host: app.example.com
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: web
                port: { number: 80 }
```

`k8s/configmap.yaml` + `k8s/secret.yaml`:

```yaml
apiVersion: v1
kind: ConfigMap
metadata: { name: web-config, namespace: app }
data:
  NODE_ENV: production
  LOG_LEVEL: info
---
apiVersion: v1
kind: Secret
metadata: { name: web-secrets, namespace: app }
type: Opaque
stringData:            # stringData auto-base64-encodes — cleaner than `data:`
  database-url: "postgres://..."
```

Apply all: `kubectl apply -f k8s/`. Delete: `kubectl delete -f k8s/`.

## Essential kubectl

```bash
# Context / namespace
kubectl config current-context
kubectl config use-context <ctx>
kubectl config set-context --current --namespace=app

# Inspect
kubectl get pods -n app
kubectl get pods -n app -o wide         # with node + IP
kubectl describe pod <pod> -n app
kubectl logs -f <pod> -n app
kubectl logs -f deployment/web -n app   # auto-picks a pod

# Exec into running container
kubectl exec -it <pod> -n app -- sh

# Port-forward (local access to cluster service — debugging)
kubectl port-forward svc/web 8080:80 -n app

# Rollout
kubectl rollout status deployment/web -n app
kubectl rollout restart deployment/web -n app    # zero-downtime restart
kubectl rollout undo deployment/web -n app       # rollback to previous
kubectl rollout history deployment/web -n app

# Scale
kubectl scale deployment/web --replicas=5 -n app

# Events (why is this broken?)
kubectl get events -n app --sort-by=.lastTimestamp
```

## Helm (templated manifests)

When manifests multiply (multiple services × multiple envs), YAML gets copy-pasty. Helm = package manager for K8s manifests.

```bash
# Install / upgrade a release
helm upgrade --install web ./charts/web \
  --namespace app --create-namespace \
  --values values-prod.yaml \
  --set image.tag=sha-abc123

# List
helm list -A

# Uninstall
helm uninstall web -n app

# 3rd-party charts (e.g. ingress-nginx, cert-manager)
helm repo add ingress-nginx https://kubernetes.github.io/ingress-nginx
helm upgrade --install ingress-nginx ingress-nginx/ingress-nginx \
  -n ingress-nginx --create-namespace
```

Chart skeleton: `charts/web/{Chart.yaml,values.yaml,templates/deployment.yaml,...}`. `templates/` uses Go templating with `{{ .Values.image.tag }}`.

Alternative: **Kustomize** (built into kubectl) — overlays without templating. `kubectl apply -k overlays/prod`. Less powerful than Helm, but simpler.

## RBAC (Role-Based Access Control)

```yaml
apiVersion: v1
kind: ServiceAccount
metadata: { name: web, namespace: app }
---
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata: { name: web, namespace: app }
rules:
  - apiGroups: [""]
    resources: [configmaps, secrets]
    verbs: [get, list]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata: { name: web, namespace: app }
subjects:
  - kind: ServiceAccount
    name: web
    namespace: app
roleRef:
  kind: Role
  name: web
  apiGroup: rbac.authorization.k8s.io
```

Reference in Deployment: `spec.template.spec.serviceAccountName: web`. Default SA has no cluster perms — only grant what the app needs (principle of least privilege).

## Autoscaling

**HPA (Horizontal Pod Autoscaler)** — replica count based on CPU/memory:

```yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata: { name: web, namespace: app }
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: web
  minReplicas: 2
  maxReplicas: 10
  metrics:
    - type: Resource
      resource:
        name: cpu
        target: { type: Utilization, averageUtilization: 70 }
```

Requires metrics-server installed on cluster.

**VPA (Vertical)** — adjusts requests/limits per pod. Install separately; incompatible with HPA on same metric.

**Cluster Autoscaler** — adds/removes nodes. Managed K8s (GKE, EKS, AKS) has this toggle; self-hosted needs operator.

## Storage

```yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata: { name: db-data, namespace: app }
spec:
  accessModes: [ReadWriteOnce]    # RWO = one node; RWX = shared (NFS/EFS); RWOP = exclusive
  resources:
    requests: { storage: 20Gi }
  storageClassName: gp3          # cloud-specific; check `kubectl get sc`
```

Mount in StatefulSet (not Deployment — Deployments don't preserve PVC-pod binding):

```yaml
volumes:
  - name: data
    persistentVolumeClaim: { claimName: db-data }
volumeMounts:
  - { name: data, mountPath: /var/lib/postgresql/data }
```

## Secrets management — the git-ops gap

Raw `Secret` YAML in git = plaintext (base64 ≠ encryption). Options:

- **SealedSecrets** (Bitnami): encrypt with cluster public key, commit `SealedSecret` YAML, controller decrypts in-cluster. Portable.
- **External Secrets Operator**: pull from AWS Secrets Manager / Vault / GCP Secret Manager. Secrets never in git.
- **sops + age**: encrypt files locally, decrypt during CI or via sops-operator.

Pick one early. Retrofitting secrets hygiene mid-project is painful.

## Deploy workflow (GH Actions)

```yaml
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: azure/setup-kubectl@v4       # or aws-actions/... for EKS
      - uses: azure/setup-helm@v4
      - name: Auth to cluster
        run: |
          echo "${{ secrets.KUBECONFIG }}" | base64 -d > $HOME/.kube/config
      - name: Deploy
        run: |
          helm upgrade --install web ./charts/web \
            --namespace app \
            --set image.tag=sha-${{ github.sha }} \
            --wait --timeout 5m
```

For EKS: use `aws-actions/configure-aws-credentials` + `aws eks update-kubeconfig`. For GKE: `google-github-actions/auth` + `gke-gcloud-auth-plugin`.

## Managed K8s quick refs

| Provider | CLI to get creds | Notes |
|----------|------------------|-------|
| **EKS** (AWS) | `aws eks update-kubeconfig --name <cluster> --region <r>` | Nodes are EC2 by default; Fargate for serverless pods |
| **GKE** (GCP) | `gcloud container clusters get-credentials <cluster>` | Autopilot mode = serverless, no node management |
| **AKS** (Azure) | `az aks get-credentials -n <cluster> -g <rg>` | |
| **DigitalOcean** | `doctl kubernetes cluster kubeconfig save <cluster>` | Cheap, minimal control plane fee |

## Common gotchas

- **`imagePullBackOff`**: registry auth missing. Create a `docker-registry` Secret and add `imagePullSecrets` in pod spec, or use IRSA (EKS) / Workload Identity (GKE) for keyless pulls
- **`CrashLoopBackOff`**: container exits → `kubectl logs <pod> --previous` shows last crash output
- **`Pending` pods forever**: cluster has no capacity (needs autoscaler) OR PVC storage class doesn't exist OR nodeSelector / taints don't match
- **Ingress 404s**: wrong `ingressClassName`, DNS not pointed at LB, TLS cert not issued yet (`kubectl describe certificate`)
- **`livenessProbe` killing healthy pods under load**: probe timeout too strict, or shares a threadpool with request handlers. Tune `timeoutSeconds` or use `/live` endpoint that doesn't touch the DB
- **Secrets rotated but pods still have old value**: env vars are frozen at pod start. Rolling-restart the deployment: `kubectl rollout restart deployment/web`
- **`kubectl apply` on a resource created with `helm install`**: Helm loses track, future upgrades fail. Stay consistent — don't mix plain kubectl + Helm for the same object
- **Namespace deletion stuck in `Terminating`**: usually a finalizer on a CRD blocking it. `kubectl get namespace <ns> -o json | jq '.spec.finalizers = []' | kubectl replace --raw /api/v1/namespaces/<ns>/finalize -f -` (cluster-admin only)
- **`latest` tag in image**: pods don't re-pull on rollout-restart unless `imagePullPolicy: Always`. Always pin to an immutable tag (sha/semver)
- **Cost surprise on managed**: control plane fee + LoadBalancer per Service + NAT gateway egress. Audit `kubectl get svc -A` for accidental LoadBalancers
