---
"@gusto/baerly-storage": patch
---

Fix the `create-baerly-storage --with=docker` add-on's container failing to start. Distroless images keep `node` at `/nodejs/bin/node`, off `PATH`, so the template's `ENTRYPOINT ["node", …]` and `HEALTHCHECK ["node", …]` could not exec. The Dockerfile now passes the server entry as `CMD` to the image's own node entrypoint and names node absolutely in the healthcheck.
