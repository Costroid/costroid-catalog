const SOL_UPLIFT = "OpenRouter is 1.1 times OpenAI's figure. The sheet keeps the global rate OpenAI's page prints.";

export const NOTES = {
  'openai:gpt-4.1-nano:global:standard:all:cache_read':
    'OpenAI prints $0.025. OpenRouter lists the same figure rounded to two decimal places.',
  'openai:gpt-5.4:global:batch:to-272000:cache_read':
    "OpenAI prints $0.13, and half of its standard cached price, $0.25, is $0.125. The sheet keeps the page's digits.",
  'openai:gpt-5.6-sol:global:standard:to-272000:input_uncached': SOL_UPLIFT,
  'openai:gpt-5.6-sol:global:standard:over-272000:input_uncached': SOL_UPLIFT,
  'openai:gpt-5.6-sol:global:standard:to-272000:output': SOL_UPLIFT,
  'openai:gpt-5.6-sol:global:standard:over-272000:output': SOL_UPLIFT,
  'openai:gpt-5.6-sol:global:standard:to-272000:cache_read': SOL_UPLIFT,
  'openai:gpt-5.6-sol:global:standard:over-272000:cache_read': SOL_UPLIFT,
  'openai:gpt-5.6-sol:global:standard:to-272000:cache_write_30m': SOL_UPLIFT,
  'openai:gpt-5.6-sol:global:standard:over-272000:cache_write_30m': SOL_UPLIFT,
  'google:gemini-3.8-flash:global:standard:all:input_uncached':
    "OpenRouter is 1.1 times Google's figure. Google's page states no such uplift.",
  'google:gemini-3.8-flash:global:standard:all:output':
    "OpenRouter is 1.1 times Google's figure. Google's page states no such uplift.",
  'google:gemini-3.8-flash:global:standard:all:cache_read':
    "OpenRouter is 1.1 times Google's figure. Google's page states no such uplift.",
  'google:gemini-3.5-flash-lite:global:batch:all:cache_read':
    "Google prints $0.02, and half of its standard cached price, $0.03, is $0.015. The sheet keeps the page's digits.",
  'cursor:gemini-3.6-flash:global:standard:all:input_uncached':
    'Cursor shows the rate Google schedules from January 1, 2027.',
  'cursor:gemini-3.6-flash:global:standard:all:cache_read':
    'Cursor shows the rate Google schedules from January 1, 2027.',
  'cursor:gemini-3.6-flash:global:standard:all:output': 'Cursor shows the rate Google schedules from January 1, 2027.',
};
