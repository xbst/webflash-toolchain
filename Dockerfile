# Reproduces the GitHub Actions build locally, stage by stage, with the same
# scripts. Expect several hours and 10 GB of disk on a cold cache.
#
#   docker build -t webflash-toolchain .
#   docker run --rm -v "$PWD/out:/out" webflash-toolchain sh -c 'cp -r /build/dist /build/package /out/'
#
# Knobs:
#   --build-arg LTO=0    skip ThinLTO (faster, larger module) for a quick script check
#   --build-arg JOBS=8   parallel compile jobs (default: nproc)
FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
      git curl ca-certificates xz-utils tar gzip python3 cmake ninja-build ccache build-essential \
    && curl -fsSL https://deb.nodesource.com/setup_24.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

ARG LTO=1
ARG JOBS=
ENV ROOT=/build LTO=$LTO JOBS=$JOBS

WORKDIR /src
COPY versions.toml LICENSE ./
COPY scripts/ scripts/
COPY patches/ patches/

RUN scripts/00-setup-emsdk.sh
RUN scripts/10-fetch-llvm.sh
RUN scripts/20-build-tablegen.sh
RUN scripts/30-build-llvm.sh

COPY src/ src/
RUN scripts/40-sysroot.sh && scripts/50-package.sh

COPY tests/ tests/
RUN scripts/60-smoke.sh
