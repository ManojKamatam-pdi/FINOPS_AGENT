/// <reference path="./.sst/platform/config.d.ts" />

export default $config({
  app(input) {
    return {
      name: "finops-agent",
      removal: input?.stage === "production" ? "retain" : "remove",
      home: "aws",
      providers: {
        aws: { region: "us-east-1" },
      },
    };
  },
  async run() {
    const { Tables } = await import("./infra/dynamodb");
    const { Secrets } = await import("./infra/secrets");
    const { Backend } = await import("./infra/backend");
    const { SchedulerLambda } = await import("./infra/scheduler");
    const { Frontend } = await import("./infra/frontend");

    const tables = await Tables();
    const secrets = await Secrets();
    const backend = await Backend(tables, secrets);
    const scheduler = await SchedulerLambda(secrets, backend);
    const frontend = await Frontend(backend);

    return {
      backendUrl: backend.url,
      frontendUrl: frontend.url,
    };
  },
});
