# Keeps this machine and its display awake while this process lives, and changes no setting:
# Windows forgets the request when the process ends. End it by its process id.
Add-Type -Namespace It -Name Awake -MemberDefinition '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint esFlags);'
# ES_CONTINUOUS | ES_SYSTEM_REQUIRED | ES_DISPLAY_REQUIRED
[void][It.Awake]::SetThreadExecutionState([uint32]'0x80000003')
while ($true) { Start-Sleep -Seconds 60; [void][It.Awake]::SetThreadExecutionState([uint32]'0x80000003') }
