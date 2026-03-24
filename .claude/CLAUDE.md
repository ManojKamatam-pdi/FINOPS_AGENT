- All UI UX stuff should be done as per pdi-claude-skills-market skills of UI/UX
- For all build agents I ask only build sdk agents and use this skill to built building full autonomous agents with the Claude Agent SDK, agent-sdk-dev Plugin claude-plugins-official
- Always use Datadog MCP thats configured for agents over APIs
- you must verify with playwright on all the fixed or implemenatations you did, and you should not mess it with lot many usecase, exactly test what you did is functional, if UI UX? check you did as per the skills as well.
- ALWAYS run Playwright using this exact pattern (never npx playwright directly — it fails on this machine):
  powershell.exe -Command "Set-Location 'C:\Users\manoj.kamatam\Documents\FinOps_Agent'; & '.\node_modules\.bin\playwright.cmd' test '<test-file>' --reporter=line 2>&1"
- "everything through SDK agent" rule: Each and every functionality and implementation we do should be done through the sdk agents that we are building, the app should fully agentic: 
- please avoid the got workspaces its causing lot of mess, just do it in the current branch that I will carry always, and no need to both much, git pushing and all all work goes directly in the current branch — no worktrees.

- App should not have mock data, hardcodings and even fallbacks until unless excemption given by user