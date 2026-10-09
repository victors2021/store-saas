#!/usr/bin/env bash
set -euo pipefail
# Disposable loopback-only development services. Never a production recipe.
postgres_image='postgres@sha256:721873c34ceb9f8d8fc265984940dc982404c105f19ad51be9fdc5970a6080ea'
redis_image='redis@sha256:858f009f9709ce576febc734aa78b8f6d624b82571f9ddb6bda4377c833b3499'
docker info >/dev/null

start_existing() {
  local service_name=$1 image=$2 port=$3
  local actual_image expected_image binding
  expected_image=$(docker image inspect --format '{{.Id}}' "$image")
  actual_image=$(docker inspect --format '{{.Image}}' "$service_name")
  binding=$(docker inspect --format "{{range (index .HostConfig.PortBindings \"$port/tcp\")}}{{.HostIp}}:{{.HostPort}}{{end}}" "$service_name")
  if [[ "$actual_image" != "$expected_image" || "$binding" != "127.0.0.1:$port" ]]; then
    echo "Existing $service_name has different image/bindings; refusing to modify it" >&2
    return 1
  fi
  docker start "$service_name" >/dev/null
}

if docker container inspect medusa-baseline-postgres >/dev/null 2>&1; then
  start_existing medusa-baseline-postgres "$postgres_image" 5432
else
  docker run -d --name medusa-baseline-postgres -p 127.0.0.1:5432:5432 \
    -e POSTGRES_HOST_AUTH_METHOD=trust "$postgres_image" >/dev/null
fi
if docker container inspect medusa-baseline-redis >/dev/null 2>&1; then
  start_existing medusa-baseline-redis "$redis_image" 6379
else
  docker run -d --name medusa-baseline-redis -p 127.0.0.1:6379:6379 "$redis_image" >/dev/null
fi
for attempt in {1..30}; do
  if docker exec medusa-baseline-postgres pg_isready -U postgres >/dev/null; then break; fi
  sleep 1
done
docker exec medusa-baseline-postgres psql -U postgres -d postgres -Atc 'SELECT 1'
docker exec medusa-baseline-redis redis-cli ping
