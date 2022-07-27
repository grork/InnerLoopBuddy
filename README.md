# Inner Loop Buddy README
![](assets/package_icon.png)

A Visual Studio Code extension that helps make your inner loop a little bit better. It does this by monitoring tasks you execute inside VS Code, and when one of those tasks matches a configured criteria, the extension opens VS Code’s built in “Simple Browser” to the URL specified.

It also lets you invoke a command manually to open the URL —  no need to type the URL every time!

## Features
- Monitors tasks
- Opens a browser document based on criteria configured in your workspace
- Manual command to open at the configured URL
- Supports multi-root workspaces

## Requirements
- Tasks that are defined in `tasks.json`
- Configured URL & Tasks to monitor

## Extension commands
| Command                                           | Purpose                                                      |
|---------------------------------------------------|--------------------------------------------------------------|
| `codevoid.inner-loop-buddy.openDefaultUrl`        | Opens the configured default URL (see below). Only available when you have a folder or workspace open. |
| `codevoid.inner-loop-buddy.startCriteriaWizard`   | Starts a quick pick wizard to help add task matching criteria to your folder or workspace settings. See below for more information. |
| `codevoid.inner-loop-buddy.printTaskCriteriaJson` | If your task configuration is complex, this command will help you print out the criteria to match a single (or all) tasks. This is intended to be used in debugging or complex scenarios. See below for more information. |

## Extension Settings
All the extension settings are available in the VS Code settings UI. For reference, the extension contributes the following settings:

| Key                                                                             | Notes                                                        |
|---------------------------------------------------------------------------------|--------------------------------------------------------------|
| `codevoid.inner-loop-buddy.defaultUrl`                                          | URL to open when the command is invoked                      |
| `codevoid.inner-loop-buddy.matchedTaskBehavior`                                 | How often the browser should be triggered. `none` (No monitoring, manual only), `onetime` (Only the first time in a session the task is observed to start), `everytime` (Every time the task starts) |
| `codevoid.inner-loop-buddy.taskMonitoringMode`                                  | Should the extension monitor for matching tasks (`matching`, the default), or `all` (Ignores matches, just any task execution). Useful if you don’t want to configure task matching rules. |
| `codevoid.inner-loop-buddy.autoOpenDelay`                                       | Delay (in ms) before opening the browser. Opening the browser may be dependent on the server completing initialization. By setting this value to non-zero, the delay of opening the browser can be configured till after that initialization |
| `codevoid.inner-loop-buddy.editorColumn`                                        | Editor column for the browser tab to open in. See the [VS Code Documenation](https://code.visualstudio.com/api/references/vscode-api#ViewColumn) for more details on the behaviour. Defaults to `Beside`. |
| `codevoid.inner-loop-buddy.monitoredTasks`                                      | Array of object shapes that will be used to find out if a task of interest has been executed. See below for more information. |
| `codevoid.inner-loop-buddy.performAvailabilityCheckBeforeOpeningBrowser`        | Preconnect to the target host when opening the browser, to ensure it's available |
| `codevoid.inner-loop-buddy.performAvailabilityCheckBeforeOpeningBrowserTimeout` | Timeout for the availability check in milliseconds |
| `codevoid.inner-loop-buddy.focusLockIndicator`                                  | Enable/disable the floating indicator that shows when the page is focused in the browser |
| `codevoid.inner-loop-buddy.automaticBrowserCacheBypass`                         | Automatically append parameters to URLs in the simple browser to bypass the browser cache |

## Multi root support
>If you are just using multiple independent folders, or a `code-workspace` with only one folder, you are golden. You can skip to the next section.

Multi root workspaces in all scenarios. For more complex multi root configurations there may be added complexity. If you configure `code-workspace` or [User level tasks](https://github.com/microsoft/vscode-docs/blob/vnext/release-notes/v1_42.md#user-level-tasks "") or extension configuration, you need to be aware of some challenges when executing tasks that will trigger opening the browser.

If the task *and* the extension configuration are at the same level (e.g. all in the workspace, or all in the folder), everything will work correctly. **However**, for tasks & monitoring criteria are configured at different levels (e.g. tasks in the workspace, criteria in a folder), we don’t know *which*  folder the task is executed in — meaning it’s difficult to make a match.

In this case, we will try and match the rules by using the *active text editors workspace*. This means that if you have tasks on the workspace, rules in folder A, and a document open from folder B, you will not see the task trigger opening the browser window.

## Configuring Task Matching Rules
If you have few, or simple rules, the extension provides a command to walk through adding it to the folder or workspace settings.

### Automatic
You can open this by:
- Opening the command palette (⇧⌘P (Mac), `Ctrl+Shift+P` (Windows, Linux)
- Search for “Add Configuration to match tasks”
- Execute it
- Select a task you want to monitor
- You’re golden!

If your task is not from the folder *and* you’ve opened a `code-workspace` or multiple folders, you’ll be asked where to place the settings.

### Manual
If you have complex configuration, or just like doing things in away you have full control over, you can use the “Print Task configuration as matching criteria configuration” from the command palette. From this you can select a single task, or all tasks. From that selection, an output window will be opened, with the JSON needed to add for the task(s) selected. Edit this as you see fit, and place in `codevoid.inner-loop-buddy.monitoredTasks` for them to be matched

### Why don’t these just match the format in `tasks.json`?
The [data provided](https://code.visualstudio.com/api/references/vscode-api#Task "") by VS Code at runtime does not directly match the configuration in `tasks.json`. A primary example of this is that `label` from `tasks.json` indicates the display name for the task — however, for objects that represent these tasks at runtime it’s called `name`. This gets more complex as the tasks get more complex, and rather than providing a mapping from one to the other, we created a loose matching of a number of properties.

Most significantly, this means that these criteria are not an **exact** match, but in fact a *subset* of the match — if the criteria you specify is *just* the `type`, then any task that is of that type will be considered a match. Tl;dr: More fields, more specific. 

## Release Notes
See [`CHANGELOG.md`](CHANGELOG.md).