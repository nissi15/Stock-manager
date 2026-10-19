$ErrorActionPreference = 'Stop'
$projectPath = Split-Path -Parent $PSScriptRoot
$resultPath = Join-Path $env:TEMP "pos-api-isolation-result-$PID.txt"

Write-Host 'Supabase two-account API isolation test' -ForegroundColor Cyan
Write-Host 'Enter each email at its prompt. Password prompts are hidden.'
Write-Host 'Do not type an email or password at a bare PS> prompt.'

try {
    $emailA = Read-Host -Prompt 'Account A email'
    $passwordA = Read-Host -Prompt 'Account A password (hidden)' -AsSecureString
    $emailB = Read-Host -Prompt 'Account B email'
    $passwordB = Read-Host -Prompt 'Account B password (hidden)' -AsSecureString
    if ([string]::IsNullOrWhiteSpace($emailA) -or [string]::IsNullOrWhiteSpace($emailB)) {
        throw 'Both account emails are required.'
    }

    $accountA = [pscredential]::new($emailA, $passwordA)
    $accountB = [pscredential]::new($emailB, $passwordB)

    $env:TEST_A_EMAIL = $accountA.UserName
    $env:TEST_A_PASSWORD = $accountA.GetNetworkCredential().Password
    $env:TEST_B_EMAIL = $accountB.UserName
    $env:TEST_B_PASSWORD = $accountB.GetNetworkCredential().Password

    Push-Location $projectPath
    try {
        $previousErrorActionPreference = $ErrorActionPreference
        $ErrorActionPreference = 'Continue'
        try {
            & npm run test:api-isolation 2>&1 | Tee-Object -FilePath $resultPath
            $testExitCode = $LASTEXITCODE
        } finally {
            $ErrorActionPreference = $previousErrorActionPreference
        }
        if ($testExitCode -ne 0) {
            Write-Host "Test failed. Results: $resultPath" -ForegroundColor Red
        } else {
            Write-Host "Test finished. Results: $resultPath" -ForegroundColor Green
        }
    } finally {
        Pop-Location
    }
} catch {
    Write-Host "Could not run the test: $($_.Exception.Message)" -ForegroundColor Red
} finally {
    Remove-Item Env:TEST_A_EMAIL, Env:TEST_A_PASSWORD, Env:TEST_B_EMAIL, Env:TEST_B_PASSWORD -ErrorAction SilentlyContinue
    Remove-Variable accountA, accountB, emailA, emailB, passwordA, passwordB -ErrorAction SilentlyContinue
    Write-Host 'Test credentials cleared from this PowerShell process.'
}
