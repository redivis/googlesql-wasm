# Builds googlesql.wasm with Bazel and Emscripten. Run through build.sh, which mounts the Bazel cache and the output
#   directory. googlesql only builds on x86-64, so this is always an amd64 image.
FROM --platform=linux/amd64 ubuntu:24.04

# autoconf/automake/libtool/m4 are for ICU's configure; python3 for googlesql's code generators
RUN apt-get update -y && \
    apt-get install -y --no-install-recommends \
    git python3 wget curl unzip ca-certificates build-essential autoconf automake libtool m4 && \
    rm -rf /var/lib/apt/lists/*

COPY .bazelversion /tmp/.bazelversion
RUN BAZEL_VERSION=$(cat /tmp/.bazelversion) && \
    wget -q -O /usr/local/bin/bazel "https://github.com/bazelbuild/bazel/releases/download/${BAZEL_VERSION}/bazel-${BAZEL_VERSION}-linux-x86_64" && \
    chmod +x /usr/local/bin/bazel && \
    bazel --version

RUN useradd -m -s /bin/bash builder && mkdir -p /home/builder/.cache/bazel /home/builder/workspace /out && \
    chown -R builder:builder /home/builder /out
USER builder
WORKDIR /home/builder/workspace

# Caches under one directory, so that the Docker volume build.sh mounts there survives rebuilds
RUN printf 'build --repository_cache=/home/builder/.cache/bazel/repository_cache\nbuild --disk_cache=/home/builder/.cache/bazel/disk_cache\n' > /home/builder/.bazelrc

COPY --chown=builder:builder .bazelrc .bazelversion MODULE.bazel BUILD.bazel googlesql_version.bzl bridge.cc ./
COPY --chown=builder:builder patches/ patches/
COPY --chown=builder:builder scripts/ scripts/

CMD ["scripts/bazel-build.sh", "/out"]
