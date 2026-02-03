# PrecisionMed Platform (Summary)

## Scope
Secure, HIPAA/GDPR-conscious precision medicine stack integrating SMART on FHIR for EHR, OMOP on Postgres, multi-omics ETL, and AI inference surfaced via FastAPI backend and Next.js frontend. Infra is provisioned with AWS CDK (ECS Fargate, HealthLake, RDS Postgres, S3, OpenSearch, WAF, VPC endpoints, Step Functions, Glue/Batch hooks).

## Services
- Backend (FastAPI): API shell, health, FHIR proxy stub, SMART callback stub, insights proxy to inference. Dockerfile in `backend/`.
- Inference (FastAPI stub): dummy insights responder on 8080. Dockerfile in `inference/`.
- Frontend (Next.js): basic landing + SMART callback placeholder. Lives in `web/`.
- Infra (CDK): `infra/` defines VPC, KMS, buckets, RDS (SSL enforced), ECS services (app + inference), ALB with TLS+WAF, NLB for inference, Cognito (MFA, groups), HealthLake with SMART authorizer ARN, VPC endpoints, OpenSearch (FGAC), Step Functions ETL chaining Glue and Batch, outputs for endpoints.

## Local Run
- Frontend: `cd web && npm install && npm run dev -- --port 3001` → http://localhost:3001
- Backend: `cd backend && python -m venv .venv && .venv\Scripts\activate && pip install -r requirements.txt && uvicorn app.main:app --reload --port 8000` → http://127.0.0.1:8000/health
- Inference (optional stub): `cd inference && python -m venv .venv && .venv\Scripts\activate && pip install -r requirements.txt && uvicorn app.main:app --host 0.0.0.0 --port 8080` → http://127.0.0.1:8080/health

## Container Images (deploy targets)
- App: `123456789012.dkr.ecr.us-east-1.amazonaws.com/precisionmed-app:latest`
- Inference: `123456789012.dkr.ecr.us-east-1.amazonaws.com/precisionmed-inference:latest`

## CDK Deploy (infra/)
```
cd infra
npm install
npx cdk synth
npx cdk deploy
```
Outputs include ALB URL (AppUrl), NLB DNS (InferenceNlbDns), OpenSearch endpoint, ETL state machine ARN. Ensure ACM cert ARN, SMART authorizer ARN, SMART URLs, and ECR images remain valid.

## Compliance and Security
- Encryption at rest via KMS (S3, RDS, OpenSearch, HealthLake). Encryption in transit via ALB TLS, HTTP→HTTPS, Postgres `rds.force_ssl=1`, VPC endpoints.
- RBAC: Cognito with MFA and groups (clinician/patient/caregiver/admin); SMART on FHIR authorizer configured.
- Network: private subnets, WAF on ALB, no public DB, VPC endpoints for S3/ECR/KMS/Logs/HealthLake.

## Next Steps
- Replace SMART callback stub with real code exchange to authorizer Lambda.
- Swap inference stub with real model server; confirm `INFERENCE_URL` env is used.
- Tighten OpenSearch permissions to index-level if needed; add real Glue/Batch logic to ETL state machine.
- Map domain to ALB with ACM cert; align SMART callback URL to deployed frontend.
