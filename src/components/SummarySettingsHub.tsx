import { Devvit, useState, useForm } from '@devvit/public-api';
import { CONSTANTS } from '../config/constants.js';

export const SummarySettingsHub: Devvit.CustomPostComponent = (context) => {

  const [prompt, setPrompt] = useState(async () => await context.redis.get('system_prompt') || CONSTANTS.SUMMARY_SYSTEM_PROMPT);
  const [url, setUrl] = useState('http://example.com');

  const promptForm = useForm(
    {
      fields: [
        {
          type: 'paragraph',
          name: 'prompt',
          label: 'AI Prompt',
          defaultValue: prompt,
        },
        {
          type: 'string',
          name: 'url',
          label: 'URL',
          defaultValue: url,
        },
      ],
    },
    async (values) => {
      if (values.prompt) {
        await context.redis.set('system_prompt', values.prompt);
        setPrompt(values.prompt);
      }
      if (values.url) {
        setUrl(values.url);
      }
      context.ui.showToast('Settings updated successfully');
    }
  );

  return (
    <blocks height="tall">
      <vstack gap="large" alignment="center" grow>
        <text style="heading" size="xxlarge">
          AI Summaries Dashboard
        </text>
        
        <vstack gap="medium" alignment="center">
          <text size="large" weight="bold">Current Settings</text>
          <text>Prompt: {prompt}</text>
          <text>URL: {url}</text>
        </vstack>
        
        <button
          appearance="primary"
          onPress={() => {
            context.ui.showForm(promptForm);
          }}
        >
          Edit Prompt
        </button>
        <button
          appearance="primary"
          onPress={() => {
            context.redis.del('system_prompt');
            context.ui.showToast('Prompt reset to default');
          }}
        >
          Reset Prompt to Default
        </button>
      </vstack>
    </blocks>
  );
};