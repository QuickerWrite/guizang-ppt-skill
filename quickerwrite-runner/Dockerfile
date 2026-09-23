FROM node:22-bookworm-slim
WORKDIR /opt/guizang-ppt-skill
COPY LICENSE README.md ./
COPY assets/template.html assets/template-swiss.html assets/motion.min.js assets/ppt-skill-showcase.png ./assets/
COPY quickerwrite-runner ./quickerwrite-runner
RUN mkdir -p /data && chown -R node:node /data /opt/guizang-ppt-skill
ENV QW_RUNNER_HOST=0.0.0.0 QW_RUNNER_PORT=8080 QW_RUNNER_OUTPUT_DIR=/data
VOLUME ["/data"]
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
USER node
CMD ["node", "quickerwrite-runner/server.mjs"]
