#!/usr/bin/env bash
set -euo pipefail
NS=gbox-fe
IMAGE="${IMAGE:-ghcr.io/thegioiao1/hunter:dev}"
ROOT=/srv/hunter
mkdir -p $ROOT/k8s/10-apps

cat > $ROOT/k8s/05-apps-config.yaml <<EOF
apiVersion: v1
kind: ConfigMap
metadata: { name: apps-config, namespace: $NS }
data:
  NODE_ENV: production
  PLATFORM_URL: https://huntershop.us
  ACCOUNTS_URL: https://accounts.huntershop.us
  CHECKOUT_URL: https://checkout.huntershop.us
  API_URL: https://api.huntershop.us
  SESSION_COOKIE_DOMAIN: .huntershop.us
  CUSTOMER_COOKIE_DOMAIN: .huntershop.us
  CORS_ALLOWED_ORIGIN_SUFFIXES: huntershop.us
  STORE_ADMIN_BASE_URL: https://admin.huntershop.us
  AWS_REGION: ap-southeast-1
  AWS_DR_REGION: ap-northeast-1
  S3_REGION: ap-southeast-1
  S3_PUBLIC_BUCKET: gbox-public-media-prod
  S3_THEME_LIBRARY_BUCKET: gbox-theme-library-prod
  S3_PRIVATE_BUCKET: gbox-private-prod
  S3_BACKUPS_BUCKET: gbox-backups-prod
  S3_BUCKET: gbox-platform
  R2_BUCKET: gbox-theme-assets
  R2_PUBLIC_BASE_URL: https://cdn.huntershop.us
  GBOX_IMAGE_CDN: imgproxy
---
apiVersion: v1
kind: Secret
metadata: { name: apps-secrets, namespace: $NS }
type: Opaque
stringData:
  AUTH_SECRET: ""
  AWS_ACCESS_KEY_ID: ""
  AWS_SECRET_ACCESS_KEY: ""
  S3_ACCESS_KEY: ""
  S3_SECRET_KEY: ""
  S3_ENDPOINT: ""
  R2_ACCESS_KEY_ID: ""
  R2_SECRET_ACCESS_KEY: ""
  R2_ENDPOINT: ""
  CLOUDFLARE_ACCOUNT_ID: ""
  CLOUDFLARE_API_TOKEN: ""
EOF

# gen_app <name> <port> <cmd> <env_name>
gen_app() {
  local name=$1 port=$2 cmd=$3 env_name=${4:-PORT}
  cat > $ROOT/k8s/10-apps/$name.yaml <<EOF
apiVersion: apps/v1
kind: Deployment
metadata:
  name: $name
  namespace: $NS
  labels: { app: $name }
spec:
  replicas: 1
  selector: { matchLabels: { app: $name } }
  template:
    metadata: { labels: { app: $name } }
    spec:
      containers:
        - name: $name
          image: $IMAGE
          imagePullPolicy: IfNotPresent
          command: ["sh","-c","$cmd"]
          ports: [{ containerPort: $port }]
          env:
            - { name: $env_name, value: "$port" }
          envFrom:
            - configMapRef: { name: apps-config }
            - secretRef:    { name: apps-secrets }
            - secretRef:    { name: gbox-db-credentials }
          readinessProbe:
            tcpSocket: { port: $port }
            initialDelaySeconds: 15
            periodSeconds: 5
            failureThreshold: 6
          resources:
            requests: { cpu: 50m, memory: 128Mi }
            limits:   { cpu: 500m, memory: 512Mi }
---
apiVersion: v1
kind: Service
metadata: { name: $name, namespace: $NS }
spec:
  selector: { app: $name }
  ports: [{ port: $port, targetPort: $port }]
EOF
}

gen_app api               4321 'node --import tsx start.mjs'                          PORT
gen_app accounts          4323 'node --import tsx apps/accounts/src/server.ts'        ACCOUNTS_PORT
gen_app god-admin         4324 'node --import tsx apps/god-admin/src/server.ts'       GOD_ADMIN_PORT
gen_app store-admin       4325 'node --import tsx apps/store-admin/src/server.ts'     STORE_ADMIN_PORT
gen_app storefront        4326 'node --import tsx storefront-start.mjs'               PORT
gen_app checkout          4327 'node --import tsx apps/checkout/src/server.ts'        CHECKOUT_PORT
gen_app supporter         4328 'node --import tsx apps/supporter/start.mjs'           SUPPORTER_PORT
gen_app god-admin-agent   4329 'node --import tsx apps/god-admin-agent/src/server.ts' PORT

cat > $ROOT/k8s/20-ingress.yaml <<EOF
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: hunter-fe-ingress
  namespace: $NS
  annotations:
    nginx.ingress.kubernetes.io/proxy-body-size: "50m"
    nginx.ingress.kubernetes.io/proxy-read-timeout: "120"
spec:
  ingressClassName: public
  rules:
    - host: huntershop.us
      http: { paths: [{ path: /, pathType: Prefix, backend: { service: { name: storefront,       port: { number: 4326 } } } }] }
    - host: api.huntershop.us
      http: { paths: [{ path: /, pathType: Prefix, backend: { service: { name: api,              port: { number: 4321 } } } }] }
    - host: accounts.huntershop.us
      http: { paths: [{ path: /, pathType: Prefix, backend: { service: { name: accounts,         port: { number: 4323 } } } }] }
    - host: god.huntershop.us
      http: { paths: [{ path: /, pathType: Prefix, backend: { service: { name: god-admin,        port: { number: 4324 } } } }] }
    - host: admin.huntershop.us
      http: { paths: [{ path: /, pathType: Prefix, backend: { service: { name: store-admin,      port: { number: 4325 } } } }] }
    - host: checkout.huntershop.us
      http: { paths: [{ path: /, pathType: Prefix, backend: { service: { name: checkout,         port: { number: 4327 } } } }] }
    - host: support.huntershop.us
      http: { paths: [{ path: /, pathType: Prefix, backend: { service: { name: supporter,        port: { number: 4328 } } } }] }
    - host: agent.god.huntershop.us
      http: { paths: [{ path: /, pathType: Prefix, backend: { service: { name: god-admin-agent,  port: { number: 4329 } } } }] }
EOF

echo "==> Done"
