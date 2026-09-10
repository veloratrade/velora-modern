# Velora Shared API Contracts Specification

## Overview
This document specifies the standard REST API contracts for the Velora platform. Both PHP reference (`veloratrade/veloratrade`) and Modern target (`veloratrade/velora-modern`) adhere to these identical contracts.

---

## 1. Standard Response Envelope

All API endpoints return standard JSON responses conforming to the following envelopes.

### 1.1 Success Response (`200 OK`, `201 Created`)
```json
{
  "status": "success",
  "data": { ... },
  "error": null,
  "timestamp": "2026-09-10T15:00:00.000Z"
}
```

### 1.2 Error Response (`4xx`, `5xx`)
```json
{
  "status": "error",
  "data": null,
  "error": {
    "code": "VALIDATION_FAILED",
    "message": "Validation failed.",
    "messageKey": "errors.validation",
    "params": {},
    "details": {
      "email": "Invalid email address format."
    }
  },
  "timestamp": "2026-09-10T15:00:00.000Z"
}
```

---

## 2. HTTP Status Codes & Error Codes Matrix

| HTTP Status | Error Code | Default `messageKey` | Conceptual Description |
| :--- | :--- | :--- | :--- |
| `400 Bad Request` | `BAD_REQUEST` | `errors.http.400` | Invalid request syntax or parameters |
| `401 Unauthorized` | `UNAUTHORIZED` | `errors.unauthorized` | Missing or invalid access token |
| `403 Forbidden` | `FORBIDDEN` | `errors.forbidden` | Authenticated user lacks required permission |
| `404 Not Found` | `NOT_FOUND` | `errors.notFound` | Endpoint or resource does not exist |
| `405 Method Not Allowed` | `METHOD_NOT_ALLOWED` | `errors.http.405` | HTTP method not permitted on endpoint |
| `409 Conflict` | `CONFLICT` | `errors.conflict` | Resource state conflict (e.g. duplicate email) |
| `413 Payload Too Large` | `PAYLOAD_TOO_LARGE` | `errors.http.413` | Request body exceeds maximum size limit |
| `422 Unprocessable` | `VALIDATION_FAILED` | `errors.validation` | Semantic field validation failure |
| `429 Too Many Requests` | `TOO_MANY_REQUESTS` | `errors.rateLimited` | Client rate limit exceeded |
| `500 Internal Error` | `INTERNAL_ERROR` | `errors.http.500` | Unhandled server error |
| `503 Service Unavailable`| `SERVICE_UNAVAILABLE` | `errors.http.503` | Database or upstream service connection failed |

---

## 3. Headers & Cookie Specifications

### 3.1 Security Headers
- `Content-Type`: `application/json; charset=utf-8`
- `X-Content-Type-Options`: `nosniff`
- `Cache-Control`: `no-store`

### 3.2 Refresh Token Cookie Contract
- **Cookie Name**: `__Host-velora_refresh`
- **Attributes**:
  - `Path=/`
  - `Secure`
  - `HttpOnly`
  - `SameSite=Strict`
  - `Max-Age=604800` (7 days)
