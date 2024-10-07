import { Devvit, useState, useForm } from '@devvit/public-api';
import { CONSTANTS } from '../config/constants.js';

const DEBUG_MODE = false; // Toggle this value manually and re-upload to see changes

export const SummarySettingsHub: Devvit.CustomPostComponent = (context) => {
  const [prompt, setPrompt] = useState(async () => await context.redis.get('system_prompt') || CONSTANTS.SUMMARY_SYSTEM_PROMPT);
  const [url, setUrl] = useState('http://example.com');
  const [selectedTab, setSelectedTab] = useState(0);
  const [summaries, setSummaries] = useState(['Summary 1', 'Summary 2', 'Summary 3']); // Placeholder summaries

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

  const resetPromptForm = useForm(
    {
      fields: [
        {
          type: 'string',
          name: 'confirmation',
          label: 'Are you sure you want to reset the prompt to default? Type "RESET" to confirm.',
        },
      ],
    },
    async (values) => {
      if (values.confirmation === 'RESET') {
        await context.redis.del('system_prompt');
        setPrompt(CONSTANTS.SUMMARY_SYSTEM_PROMPT);
        context.ui.showToast('Prompt reset to default');
      } else {
        context.ui.showToast('Reset cancelled');
      }
    }
  );

  const prompts = [prompt, 'Prompt 2', 'Prompt 3']; // Placeholder prompts

  const handleUsePrompt = async (selectedPrompt: string) => {
    try {
      await context.redis.set('system_prompt', selectedPrompt);
      setPrompt(selectedPrompt);
      context.ui.showToast('Prompt updated successfully');
    } catch (error) {
      context.ui.showToast('Failed to update prompt');
    }
  };

  return (
    <blocks height="tall">
      <vstack height="100%" borderColor={DEBUG_MODE ? 'red' : 'transparent'} border={DEBUG_MODE ? 'thin' : 'none'}>
        <text style="heading" size="xxlarge">AI Summaries Dashboard</text>
        
        <hstack gap="medium" alignment="center middle" borderColor={DEBUG_MODE ? 'blue' : 'transparent'} border={DEBUG_MODE ? 'thin' : 'none'}>
          <button
            appearance="primary"
            onPress={() => {
              context.ui.showForm(promptForm);
            }}
          >
            Edit Prompt
          </button>
          <button
            appearance="secondary"
            onPress={() => {
              context.ui.showForm(resetPromptForm);
            }}
          >
            Reset Prompt to Default
          </button>
        </hstack>

        <hstack grow borderColor={DEBUG_MODE ? 'green' : 'transparent'} border={DEBUG_MODE ? 'thin' : 'none'}>  
          {/* prompts sidebar */}

            <vstack maxWidth="30%" borderColor={DEBUG_MODE ? 'yellow' : 'transparent'} border={DEBUG_MODE ? 'thin' : 'none'}>
            <zstack maxWidth="30%">
              <vstack minHeight="34px" backgroundColor="green" cornerRadius="medium" width="75px">
                <text size="large" weight="bold" color="white">Prompts</text>
                <spacer size="medium" />
              </vstack>
              {prompts.map((p, index) => (
                <vstack
                  key={index.toString()}
                  borderColor="neutral-border-strong"
                  border="thin"
                  //padding="small"
                  cornerRadius="medium"
                  onPress={() => setSelectedTab(index)}
                >
                  <text
                    overflow="ellipsis"
                    color={selectedTab === index ? 'blue' : 'neutral-content'}
                  >
                    {p}
                  </text>
                </vstack>
              ))}
            </zstack>
          </vstack>
          {/* summary display */}
          <vstack grow borderColor={DEBUG_MODE ? 'yellow' : 'transparent'} border={DEBUG_MODE ? 'thin' : 'none'}>
            <vstack gap="small" grow borderColor={DEBUG_MODE ? 'purple' : 'transparent'} border={DEBUG_MODE ? 'thin' : 'none'}>
              <hstack>
                <text size="large" weight="bold">Summary</text>
                <spacer grow />
                <button
                  appearance="primary"
                  size="small"
                  onPress={() => handleUsePrompt(prompts[selectedTab])}
                >
                  Use this prompt
                </button>
                <spacer size="small" />
              </hstack>
              <text>{summaries[selectedTab]}</text>
            </vstack>
          </vstack>   
        </hstack>
      </vstack>
    </blocks>
  );
};