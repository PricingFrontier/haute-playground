# One visitor's playground session: this project, served by plain `haute serve`
# on 127.0.0.1:8000, with Caddy on :8080 in front so the visitor's browser
# reaches it as if it were local. Build from the repo root:
#
#   docker build -f container/Dockerfile -t haute-playground .
#   docker run -p 8080:8080 -e PUBLIC_ORIGIN=http://localhost:8080 haute-playground
FROM ghcr.io/astral-sh/uv:python3.13-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends git libgomp1 \
 && rm -rf /var/lib/apt/lists/*
COPY --from=caddy:2 /usr/bin/caddy /usr/bin/caddy
COPY container/Caddyfile /etc/caddy/Caddyfile
COPY --chmod=755 container/entrypoint.sh /usr/local/bin/playground

# Haute's Git panel commits as this identity, so a visitor is never asked who they are
RUN useradd --create-home --uid 1000 haute \
 && git config --system user.name "Playground" \
 && git config --system user.email "playground@pricing-frontier.co.uk" \
 && git config --system init.defaultBranch main \
 && install -d -o haute -g haute /project

ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy UV_PYTHON_DOWNLOADS=never
WORKDIR /project
USER haute

# Dependencies first, so a change to the pipeline or data doesn't reinstall them
COPY --chown=haute:haute pyproject.toml uv.lock .python-version ./
RUN uv sync --frozen --no-dev --no-install-project

# The project the visitor opens, with its first commit and a working branch
# already made by Haute's own code (it keeps data/ out of git, as for any
# project), so Haute opens on the canvas rather than asking for a branch.
COPY --chown=haute:haute . .
RUN rm -rf container \
 && git init -q \
 && .venv/bin/python -c "from pathlib import Path; from haute._git_setup import set_working_branch; p = Path.cwd(); set_working_branch('playground', p, create=True, cwd=p)" \
 && git branch --list && cat .haute/state.json

EXPOSE 8080
ENTRYPOINT ["playground"]
