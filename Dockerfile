# Runner image for the Cloud Run Job `peoplelake-runner` (production) and the CI `runner-image` job.
# Built by Cloud Build in production (infra/gcp/cloudbuild.yaml); Docker is not needed on a laptop.
FROM python:3.12-slim

# UV_NO_CACHE: uv's download cache (about 800 MB, a second copy of every installed package) must not be
# baked into a layer; every image byte counts against Artifact Registry's 0.5 GB free storage.
ENV TZ=UTC \
    PYTHONUNBUFFERED=1 \
    UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_NO_CACHE=1 \
    PL_REPO_ROOT=/app \
    PL_DATA_DIR=/tmp/peoplelake

RUN pip install --no-cache-dir uv==0.12.17

WORKDIR /app
COPY pipeline/pyproject.toml pipeline/uv.lock pipeline/
RUN cd pipeline && uv sync --locked --no-dev --no-install-project
COPY pipeline/src pipeline/src
COPY warehouse warehouse
RUN cd pipeline && uv sync --locked --no-dev \
    && useradd --create-home --uid 10001 runner \
    && mkdir -p /tmp/peoplelake && chown -R runner /tmp/peoplelake /app/warehouse

USER runner
ENTRYPOINT ["/app/pipeline/.venv/bin/peoplelake"]
CMD ["runner", "run", "--until-idle", "15", "--target", "prod"]
