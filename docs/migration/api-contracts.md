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

---

## 4. Trading & Journaling Engine API Contracts

All endpoints below require standard Bearer Authentication (`Authorization: Bearer <token>`).

### 4.1 Search Trades (`GET /api/v1/trades`)
- **Query Parameters**:
  - `symbol`: Filter by trade symbol substring (e.g. `EURUSD`).
  - `direction`: Filter by direction (`buy` | `sell`).
  - `startDate`: Filter by openTime >= startDate (`YYYY-MM-DD`).
  - `endDate`: Filter by closeTime <= endDate (`YYYY-MM-DD`).
  - `page`: Page number (default `1`).
  - `limit`: Items per page (default `20`, max `100`).
- **Response `data`**:
  ```json
  {
    "items": [ TradeObject ],
    "pagination": {
      "page": 1,
      "limit": 20,
      "total": 42,
      "totalPages": 3
    }
  }
  ```

### 4.2 Get Trade by ID (`GET /api/v1/trades/:id`)
- **Path Parameter**: `id` (integer)
- **Response `data`**: `TradeObject`
- **Security**: Ownership isolation enforced (`404` if trade does not exist or belongs to another user).

### 4.3 Create Manual Trade (`POST /api/v1/trades`)
- **Request Body**:
  ```json
  {
    "symbol": "EURUSD",
    "direction": "buy",
    "entryPrice": "1.1000",
    "exitPrice": "1.1050",
    "volume": "1.0",
    "contractSize": "100000",
    "commission": "5.00",
    "swap": "1.50",
    "stopLoss": "1.0970",
    "takeProfit": "1.1150",
    "accountId": 1,
    "openTime": "2026-09-10 10:00:00",
    "closeTime": "2026-09-10 12:00:00",
    "strategyTag": "Breakout",
    "emotionalScore": 4,
    "notes": "H1 clean breakout"
  }
  ```
- **Response**: `201 Created` with `TradeObject`. Financial metrics (`profitLoss`, `rMultiple`) calculated automatically.

### 4.4 Update Trade (`PUT /api/v1/trades/:id`)
- **Path Parameter**: `id` (integer)
- **Request Body**: Partial update fields (`symbol`, `direction`, `entryPrice`, `exitPrice`, `volume`, `commission`, `swap`, `stopLoss`, `takeProfit`, `openTime`, `closeTime`, `strategyTag`, `emotionalScore`, `notes`).
- **Response**: `200 OK` with updated `TradeObject`. Recalculates `profitLoss` and `rMultiple`.

### 4.5 Delete Trade (`DELETE /api/v1/trades/:id`)
- **Path Parameter**: `id` (integer)
- **Response**: `200 OK` with `{ "messageKey": "trades.deleted" }`.

### 4.6 List Trade Exits (`GET /api/v1/trades/:id/exits`)
- **Path Parameter**: `id` (integer)
- **Response `data`**: `{ "items": [ TradeExitObject ] }`.

### 4.7 Create Partial Exit (`POST /api/v1/trades/:id/exits`)
- **Path Parameter**: `id` (integer)
- **Request Body**:
  ```json
  {
    "exitType": "tp",
    "exitPrice": "1.1030",
    "volume": "0.5",
    "exitedAt": "2026-09-10 11:00:00",
    "notes": "TP1 partial close"
  }
  ```
- **Response**: `201 Created` with exit ID. Validates cumulative volume limit and chronology (`openTime <= exitedAt <= closeTime`).

### 4.8 Delete Partial Exit (`DELETE /api/v1/trades/exits/:exitId`)
- **Path Parameter**: `exitId` (integer)
- **Response**: `200 OK` with `{ "messageKey": "trades.exitDeleted" }`.
