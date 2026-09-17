# dev.ps1 — Run the Next.js dev server using the portable Node.js installation
$nodePath = "$env:LOCALAPPDATA\nodejs-portable\node-v22.17.1-win-x64"
$env:PATH = "$nodePath;$env:PATH"
node "$PSScriptRoot\node_modules\next\dist\bin\next" dev
