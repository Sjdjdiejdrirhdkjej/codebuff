#!/usr/bin/env node

import { type CostMode } from '@codebuff/common/old-constants'
import { AnalyticsEvent } from '@codebuff/common/constants/analytics-events'
import { Command, Option } from 'commander'
import { red, yellow, green, bold } from 'picocolors'
import inquirer from 'inquirer'
import axios from 'axios'

import { displayLoadedAgents, loadLocalAgents } from './agents/load-agents'
import { CLI } from './cli'
import { cliArguments, cliOptions } from './cli-definitions'
import { handlePublish } from './cli-handlers/publish'
import { handleInitAgents } from './cli-handlers/init-agents'
import { handleSaveAgent } from './cli-handlers/save-agent'
import { npmAppVersion, backendUrl, GOOGLE_AI_API_ENDPOINT } from './config'
import { createTemplateProject } from './create-template-project'
import { printModeLog, setPrintMode } from './display/print-mode'
import { enableSquashNewlines } from './display/squash-newlines'
import { loadCodebuffConfig } from './json-config/parser'
import {
  getProjectRoot,
  getWorkingDirectory,
  initializeProjectRootAndWorkingDir,
  initProjectFileContextWithWorker,
} from './project-files'
import { rageDetectors } from './rage-detectors'
import { logAndHandleStartup } from './startup-process-handler'
import { recreateShell } from './terminal/run-command'
import { validateAgentDefinitionsIfAuthenticated } from './utils/agent-validation'
import { initAnalytics, trackEvent } from './utils/analytics'
import { logger } from './utils/logger'

import type { CliOptions } from './types'

async function getValidApiKey(): Promise<string> {
  const apiKeys = [
    process.env.GEMINI_API_KEY,
    process.env.GOOGLE_API_KEY,
  ].filter(Boolean) as string[];

  for (const apiKey of apiKeys) {
    let retries = 3;
    while (retries > 0) {
      try {
        await axios.get(GOOGLE_AI_API_ENDPOINT, {
          headers: {
            'x-goog-api-key': apiKey,
          },
        });
        console.log(green('Using a valid API key from environment variables.'))
        return apiKey;
      } catch (error: any) {
        if (error.response?.status === 400) {
          console.log(yellow(`API key starting with ${apiKey.substring(0, 4)}... is invalid. Trying next key.`));
          break; // Break the while loop to try the next key
        } else {
          retries--;
          if (retries === 0) {
            console.error(red('Error validating API key after multiple retries:'), error);
            process.exit(1);
          }
          console.log(yellow(`Error validating API key, retrying in 2 seconds... (${retries} retries left)`));
          await new Promise(res => setTimeout(res, 2000));
        }
      }
    }
  }

  // If no valid key is found in env vars, prompt the user
  let retries = 3;
  while(retries > 0) {
    const { apiKey } = await inquirer.prompt([
      {
        type: 'password',
        name: 'apiKey',
        message: 'Please enter your Google AI API key:',
        mask: '*',
      },
    ]);

    try {
      await axios.get(GOOGLE_AI_API_ENDPOINT, {
        headers: {
          'x-goog-api-key': apiKey,
        },
      });
      return apiKey;
    } catch (error) {
      retries--;
      if (retries === 0) {
        console.error(red('The provided API key is invalid after multiple retries.'), error);
        process.exit(1);
      }
      console.log(yellow(`The provided API key is invalid. Please try again. (${retries} retries left)`));
    }
  }
  // This should not be reached, but typescript needs a return path
  return '';
}

function isGemini2point5OrGreater(modelName: string): boolean {
  const match = modelName.match(/gemini-([0-9.]+)/);
  if (match && match[1]) {
    const version = parseFloat(match[1]);
    return version >= 2.5;
  }
  return false;
}

async function getGeminiConfig() {
  const apiKey = await getValidApiKey();

  try {
    const response = await axios.get(GOOGLE_AI_API_ENDPOINT, {
      headers: {
        'x-goog-api-key': apiKey,
      },
    });

    const models = response.data.models
      .filter((model: any) => isGemini2point5OrGreater(model.name))
      .map((model: any) => ({
        name: `${model.displayName} (${model.name})`,
        value: model.name,
      }));

    if (models.length === 0) {
      console.error(red('No valid Gemini 2.5 or newer models found.'));
      process.exit(1);
    }

    const answers = await inquirer.prompt([
      {
        type: 'list',
        name: 'model',
        message: 'Please select a Gemini model to use:',
        choices: models,
      },
    ]);

    return { apiKey, model: answers.model };
  } catch (error) {
    console.error(red('Error fetching Gemini models:'), error);
    process.exit(1);
  }
}

async function codebuff({
  initialInput,
  git,
  costMode,
  runInitFlow,
  model,
  agent,
  params,
  print,
  cwd,
  trace,
  apiKey,
}: CliOptions) {
  enableSquashNewlines()
  const workingDir = getWorkingDirectory()
  const projectRoot = getProjectRoot()
  await recreateShell(workingDir)

  // Kill all processes we failed to kill before
  const processCleanupPromise = logAndHandleStartup()

  initAnalytics()
  rageDetectors.startupTimeDetector.start()

  const initFileContextPromise = initProjectFileContextWithWorker(projectRoot)

  // Load agents and validate definitions
  const loadAndValidatePromise: Promise<void> = loadLocalAgents({
    verbose: true,
  }).then((agents) => {
    validateAgentDefinitionsIfAuthenticated(Object.values(agents))

    const codebuffConfig = loadCodebuffConfig()
    if (!agent) {
      displayLoadedAgents(codebuffConfig)
    }
  })

  const readyPromise = Promise.all([
    initFileContextPromise,
    processCleanupPromise,
    loadAndValidatePromise,
  ])

  // Initialize the CLI singleton
  CLI.initialize(readyPromise, {
    git,
    costMode,
    model,
    agent,
    params,
    print,
    trace,
    apiKey,
  })

  const cli = CLI.getInstance()
  await cli.printInitialPrompt({ initialInput, runInitFlow })

  rageDetectors.startupTimeDetector.end()
}

if (require.main === module) {
  const program = new Command()

  program.name('codebuff').version(npmAppVersion || '0.0.0')

  // Add arguments from shared definitions
  cliArguments.forEach((arg) => {
    // For hidden arguments, just skip adding them to the help text
    if (!arg.hidden) {
      program.argument(arg.flags, arg.description)
    }
  })

  // Add options from shared definitions
  cliOptions.forEach((opt) => {
    const optionInstance = new Option(opt.flags, opt.description)
    if (opt.hidden) {
      optionInstance.hideHelp(true)
    }
    program.addOption(optionInstance)
  })

  program.addHelpText(
    'after',
    `
Examples:
  $ codebuff                                  # Start in current directory
  $ codebuff -p "tell me about the codebase"  # Print mode (non-interactive)
  $ codebuff --cwd my-project                 # Start in specific directory
  $ codebuff --trace                          # Enable subagent trace logging to .agents/traces/*.log
  $ codebuff --create nextjs my-app           # Create and scaffold a new Next.js project
  $ codebuff init-agents                      # Create example agent files in .agents directory
  $ codebuff save-agent my-agent-id           # Add agent ID to spawnable agents list
  $ codebuff publish my-agent                 # Publish agent template to store
  $ codebuff --agent file-picker "find relevant files for authentication"
  $ codebuff --agent reviewer --params '{"focus": "security"}' "review this code"

For all commands and options, run 'codebuff' and then type 'help'.
`,
  )

  program.action(async (args: string[], options: any) => {
    const geminiConfig = await getGeminiConfig();

    // Initialize project root and working directory
    initializeProjectRootAndWorkingDir(options.cwd)

    if (options.create) {
      const template = options.create
      const projectDir = args[0] || '.'
      const projectName = args[1] || template
      createTemplateProject(template, projectDir, projectName)
      process.exit(0)
    }

    // Handle publish command
    if (args[0] === 'publish') {
      const agentNames = args.slice(1)
      await handlePublish(agentNames)
      process.exit(0)
    }

    // Handle init-agents command
    if (args[0] === 'init-agents') {
      await handleInitAgents()
      process.exit(0)
    }

    // Handle save-agent command
    if (args[0] === 'save-agent') {
      const agentIds = args.slice(1)
      await handleSaveAgent(agentIds)
      process.exit(0)
    }

    // Handle deprecated --pro flag
    if (options.pro) {
      console.error(
        red(
          'Warning: The --pro flag is deprecated. Please restart codebuff and use the --max option instead.',
        ),
      )
      logger.error(
        {
          errorMessage:
            'The --pro flag is deprecated. Please restart codebuff and use the --max option instead.',
        },
        'Deprecated --pro flag used',
      )
      process.exit(1)
    }

    // Determine cost mode
    let costMode: CostMode = 'normal'
    if (options.lite) {
      costMode = 'lite'
    } else if (options.max) {
      costMode = 'max'
    } else if (options.experimental) {
      costMode = 'experimental'
    } else if (options.ask) {
      costMode = 'ask'
    }

    // Handle git integration
    const git = options.git === 'stage' ? ('stage' as const) : undefined

    // Validate print mode requirements
    if (options.print) {
      const hasPrompt = args.length > 0
      const hasParams = options.params

      setPrintMode(true)
      trackEvent(AnalyticsEvent.PRINT_MODE, {
        args,
        options,
      })

      if (!hasPrompt && !hasParams) {
        printModeLog({
          type: 'error',
          message: 'Error: Print mode requires a prompt to be set',
        })
        process.exit(1)
      }
    }

    // Parse agent params if provided
    let parsedAgentParams: Record<string, any> | undefined
    if (options.params) {
      try {
        parsedAgentParams = JSON.parse(options.params)
      } catch (error) {
        console.error(red(`Error parsing --params JSON: ${error}`))
        process.exit(1)
      }
    }

    // Remove the first argument if it's the compiled binary path which bun weirdly injects (starts with /$bunfs)
    const filteredArgs = args[0]?.startsWith('/$bunfs') ? args.slice(1) : args

    // If first arg is a command like 'publish' or 'save-agent', don't treat it as initial input
    const isCommand = ['publish', 'init-agents', 'save-agent'].includes(
      filteredArgs[0],
    )
    const initialInput = isCommand ? '' : filteredArgs.join(' ')

    codebuff({
      initialInput,
      git,
      costMode,
      runInitFlow: options.init,
      model: geminiConfig.model,
      agent: options.agent,
      params: parsedAgentParams,
      print: options.print,
      cwd: options.cwd,
      trace: options.trace,
      apiKey: geminiConfig.apiKey,
    })
  });

  program.parse(process.argv);
}
