export function downloadJson(filename: string, data: unknown) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
  triggerDownload(filename, blob)
}

export function downloadCsv(filename: string, headers: string[], rows: (string | number)[][]) {
  const lines = [headers.join(','), ...rows.map((r) => r.map((v) => `${v}`).join(','))]
  const blob = new Blob([lines.join('\n')], { type: 'text/csv' })
  triggerDownload(filename, blob)
}

function triggerDownload(filename: string, blob: Blob) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}
