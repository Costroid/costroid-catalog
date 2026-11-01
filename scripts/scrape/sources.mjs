const GITHUB_ARTICLE = 'https://docs.github.com/api/article/body?pathname=/en/copilot/reference';

export const PAGES = [
  {
    id: 'anthropic-pricing',
    provider: 'anthropic',
    url: 'https://platform.claude.com/docs/en/about-claude/pricing.md',
    file: 'pages/anthropic-pricing.md',
  },
  {
    id: 'anthropic-model-status',
    provider: 'anthropic',
    url: 'https://platform.claude.com/docs/en/about-claude/model-deprecations.md',
    file: 'pages/anthropic-model-status.md',
  },
  {
    id: 'anthropic-thinking',
    provider: 'anthropic',
    url: 'https://platform.claude.com/docs/en/build-with-claude/thinking.md',
    file: 'pages/anthropic-thinking.md',
  },
  {
    id: 'openai-pricing',
    provider: 'openai',
    url: 'https://developers.openai.com/api/docs/pricing.md',
    file: 'pages/openai-pricing.md',
  },
  {
    id: 'openai-reasoning',
    provider: 'openai',
    url: 'https://developers.openai.com/api/docs/guides/reasoning.md',
    file: 'pages/openai-reasoning.md',
  },
  {
    id: 'google-pricing',
    provider: 'google',
    url: 'https://ai.google.dev/gemini-api/docs/pricing.md.txt',
    file: 'pages/google-pricing.md',
  },
  {
    id: 'github-copilot-pricing',
    provider: 'github-copilot',
    url: `${GITHUB_ARTICLE}/copilot-billing/models-and-pricing`,
    file: 'pages/github-copilot-pricing.md',
  },
  {
    id: 'github-copilot-legacy-multipliers',
    provider: 'github-copilot',
    url: `${GITHUB_ARTICLE}/copilot-billing/request-based-billing-legacy/model-multipliers-for-annual-plans`,
    file: 'pages/github-copilot-legacy-multipliers.md',
  },
  {
    id: 'github-copilot-legacy-requests',
    provider: 'github-copilot',
    url: `${GITHUB_ARTICLE}/copilot-billing/request-based-billing-legacy/copilot-requests`,
    file: 'pages/github-copilot-legacy-requests.md',
  },
  {
    id: 'cursor-pricing',
    provider: 'cursor',
    url: 'https://cursor.com/docs/models-and-pricing.md',
    file: 'pages/cursor-pricing.md',
  },
];

export const CROSSCHECKS = [
  {
    id: 'litellm-map',
    url: 'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json',
    file: 'crosscheck/litellm-model-prices.json',
  },
  {
    id: 'openrouter-listing',
    url: 'https://openrouter.ai/api/v1/models',
    file: 'crosscheck/openrouter-models.json',
  },
];
