from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    app_env: str = "dev"
    fhir_datastore_endpoint: str | None = None
    fhir_region: str | None = None
    smart_issuer: str | None = None
    smart_client_id: str | None = None
    omop_db_host: str = "localhost"
    omop_db_port: int = 5432
    omop_db_name: str = "postgres"
    omop_db_user: str = "postgres"
    omop_db_password: str = ""
    omop_db_sslmode: str = "require"
    app_shared_secret: str = "change-me"
    inference_url: str | None = None

    model_config = SettingsConfigDict(env_file=".env", env_prefix="", env_file_encoding="utf-8")


def get_settings() -> Settings:
    return Settings()
