#!/usr/bin/env bash
# 用法: ./run-one.sh <tag> [extension-args...]
set -u
TAG="$1"; shift
WORK="$(pwd)/work"
SESS="$(pwd)/sessions/$TAG"
mkdir -p "$WORK" "$SESS"
unset DSH_MINIMAL_PRESET DSH_MINIMAL_SHELL DSH_MINIMAL_KICKOFF DSH_ANCHOR_SHELL DSH_ANCHOR_PROMOTE_ON DSH_ANCHOR_TURN DSH_ANCHOR_COMPACTION_TOOLS
START=$(date +%s)
(cd "$WORK" && pi -p --session-dir "$SESS" "$@" "@$(pwd)/../prompt.txt" > "../out-$TAG.txt" 2> "../err-$TAG.txt")
CODE=$?
END=$(date +%s)
echo "exit=$CODE wall=$((END-START))s" > "meta-$TAG.txt"
echo "RUN $TAG: exit=$CODE wall=$((END-START))s"
exit $CODE
