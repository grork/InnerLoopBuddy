# Inner Loop Buddy README
A Visual Studio Code extension that helps make your inner loop a little bit better. It does this by monitoring for tasks that execute inside VS Code, and when one of them matches a configured criteria, opens VS Code’s built in “Simple Browser” to the URL specified.

It also lets you invoke a command manually to open the URL —  no need to type the URL every time.
## Features
- Monitors tasks
- Opens a browser window based on criteria configured in your workspace
- Manual command to open at the configured URL
- Supports multi-root workspaces
## Requirements
- Tasks that are defined in `tasks.json`
- Configured URL & Tasks to monitor

## Extension Settings
This extension contributes the following settings:

| Key                                        | Notes                                                        |
|--------------------------------------------|--------------------------------------------------------------|
| `codevoid.inner-loop-buddy.defaultUrl`     | URL to open when the command is invoked                      |
| `codevoid.inner-loop-buddy.monitoredTasks` | Array of object shapes that will be used to find out if a task of interest has been executed |
| `codevoid.inner-loop-buddy.taskBehavior`   | How often the browser should be triggered. `none` (No monitoring, manual only), `onetime` (Only the first time in a session the task is observed to start), `everytime` (Every time the task starts) |
## Known Issues
## Release Notes