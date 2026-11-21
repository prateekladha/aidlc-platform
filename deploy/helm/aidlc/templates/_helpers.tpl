{{- define "aidlc.labels" -}}
app.kubernetes.io/part-of: aidlc
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ .Chart.Name }}-{{ .Chart.Version }}
{{- end }}

{{- define "aidlc.image" -}}
{{ .Values.image.registry }}/{{ .Values.image.repo }}:{{ .Values.image.tag }}
{{- end }}
