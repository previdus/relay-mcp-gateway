package mcp.authz

default allow := false

allow if {
  input.action == "tools/call"
  input.principal.roles[_] == "reader"
  input.resource.name == "alpha__echo"
}

allow if {
  input.action == "resources/read"
  input.principal.id == "report-agent"
  input.resource.name == "resource://monthly-report"
}
