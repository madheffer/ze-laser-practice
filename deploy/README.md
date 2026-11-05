# Deploying

The site runs on the box (192.168.20.32) as Helm's **laser-game** bundle, which runs the local Docker image
`lasers:latest` (built from [web/Dockerfile](../web/Dockerfile)) with the baked maps mounted from
`/srv/storage/data500/lasers-assets` (uploaded separately from git; see BAKING.md).

## Ship a change

1. Commit, then push: `git push box main`
2. The box builds the image in the background (`deploy/post-receive`, ~2-3 min). Watch it:
   `ssh -i ~/.ssh/homelab dev@192.168.20.32 tail -f lasers-build.log`
3. When the log says `built lasers:latest`, deploy **laser-game** in Helm's UI. Helm shows the commit it runs
   (the image's `org.opencontainers.image.revision` label).

A push only ever builds; putting a build live is done in Helm.

## Install / update the hook

The hook lives in this folder so it is versioned; copy it to the box after changing it:

```bash
scp -i ~/.ssh/homelab deploy/post-receive dev@192.168.20.32:repos/ze-laser-practice.git/hooks/post-receive
ssh -i ~/.ssh/homelab dev@192.168.20.32 chmod +x repos/ze-laser-practice.git/hooks/post-receive
```

To rebuild without a new commit (e.g. after a failed build), on the box:
`echo "x $(git --git-dir=repos/ze-laser-practice.git rev-parse main) refs/heads/main" | (cd repos/ze-laser-practice.git && hooks/post-receive)`
