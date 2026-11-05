# Build stage compiles the Rust extension (crates/core) into the venv via maturin.
FROM ghcr.io/astral-sh/uv:0.12.5-python3.12-trixie AS build
RUN curl -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal
ENV PATH=/root/.cargo/bin:$PATH UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy UV_PYTHON_DOWNLOADS=never
WORKDIR /app
COPY Cargo.toml Cargo.lock ./
COPY crates crates
COPY services/worker-py/pyproject.toml services/worker-py/uv.lock services/worker-py/
RUN cd services/worker-py && uv sync --locked --no-dev --no-editable
COPY services/worker-py/worker services/worker-py/worker

FROM python:3.12-slim-trixie
RUN useradd --system --uid 10001 worker
COPY --from=build /app/services/worker-py /app/services/worker-py
COPY config /app/config
WORKDIR /app/services/worker-py
ENV PATH=/app/services/worker-py/.venv/bin:$PATH PYTHONUNBUFFERED=1
USER worker
CMD ["python", "-m", "worker"]
