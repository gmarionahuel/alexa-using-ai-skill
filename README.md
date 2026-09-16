# Alexa using IA Skill

Custom Skill de Alexa conectada a una Supabase Edge Function para conversar con un LLM y consultar información actual mediante herramientas.

## Características

- Validación de firma y certificado de Amazon, timestamp, Skill ID y replay.
- Groq como proveedor LLM predeterminado, configurable por variables de entorno.
- Rotación de API keys almacenadas en una tabla backend-only.
- Búsqueda web, noticias, cotizaciones, criptomonedas y scraping.
- Contexto breve mediante `sessionAttributes`, sin persistir conversaciones por defecto.
- Modelo de interacción para español de México con expresiones naturales.
- Presupuesto de ejecución pensado para el límite de respuesta de Alexa.

## Estructura

```text
alexa-skill-package/                 Modelo y manifest de Alexa
supabase/functions/alexa-webhook/   Webhook autenticado y agente
supabase/migrations/                 Esquema y funciones SQL
docs/                                Arquitectura, configuración y seguridad
```

## Instalación

1. Crear un proyecto de Supabase.
2. Aplicar las migraciones en orden.
3. Configurar los secretos indicados en `.env.example`.
4. Cargar las credenciales de proveedores en `key_manager.api_keys` desde un entorno seguro.
5. Desplegar `alexa-webhook` con verificación JWT desactivada. Alexa no envía JWT de Supabase; la función verifica la firma de Amazon internamente.
6. Reemplazar `YOUR_PROJECT_REF` en `alexa-skill-package/skill.json`.
7. Importar o pegar `alexa-skill-package/interactionModels/custom/es-MX.json` y construir el modelo.

```bash
supabase functions deploy alexa-webhook --no-verify-jwt
```

## Variables obligatorias

- `ALEXA_SKILL_ID`: identificador de la Custom Skill.
- `SUPABASE_URL`: inyectada por Supabase.
- `SUPABASE_SERVICE_ROLE_KEY` o `SUPABASE_SECRET_KEYS`: inyectada por Supabase.

Los endpoints públicos de los proveedores están centralizados en `config.ts`. El repositorio no contiene project refs, Skill IDs ni API keys reales.

## Seguridad

Este proyecto utiliza claves en texto plano porque reproduce la arquitectura solicitada originalmente. La tabla está aislada del acceso `anon`/`authenticated` y solamente las RPC del backend pueden seleccionarlas. Para una instalación nueva se recomienda adaptar el key manager a Supabase Vault o a un gestor externo.

Revisá [SECURITY.md](SECURITY.md) antes de desplegar una instancia pública.

## Licencia

MIT.
