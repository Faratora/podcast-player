$prefix = " "
$date = Get-Date -Format "yyyy-MM-dd"
$culture = [System.Globalization.CultureInfo]::GetCultureInfo("en-US")
$dayOfWeek = (Get-Date).ToString("ddd", $culture)
$month = (Get-Date).ToString("MMM", $culture)
$time = (Get-Date).ToString("HH:mm:ss")
$message = "$prefix ($dayOfWeek $month $date $time)"
Set-Clipboard -Value $message
Write-Host "Copied: $message"