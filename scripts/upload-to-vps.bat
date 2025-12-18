@echo off
REM ==============================================================================
REM Script para enviar arquivos para o VPS
REM ==============================================================================

set VPS_IP=5.161.41.167
set VPS_USER=root
set VPS_DIR=/opt/liquidation-bot
set LOCAL_DIR=%~dp0..

echo ===============================================================
echo   UPLOAD PARA VPS - LIQUIDATION BOT V2
echo ===============================================================
echo.
echo VPS: %VPS_USER%@%VPS_IP%
echo Destino: %VPS_DIR%
echo.

REM Criar diretório no VPS
echo [1/4] Criando diretorio no VPS...
ssh %VPS_USER%@%VPS_IP% "mkdir -p %VPS_DIR%"

REM Enviar arquivos principais
echo [2/4] Enviando arquivos do projeto...
scp -r "%LOCAL_DIR%\bot" %VPS_USER%@%VPS_IP%:%VPS_DIR%/
scp -r "%LOCAL_DIR%\scripts" %VPS_USER%@%VPS_IP%:%VPS_DIR%/
scp -r "%LOCAL_DIR%\data" %VPS_USER%@%VPS_IP%:%VPS_DIR%/
scp "%LOCAL_DIR%\package.json" %VPS_USER%@%VPS_IP%:%VPS_DIR%/
scp "%LOCAL_DIR%\package-lock.json" %VPS_USER%@%VPS_IP%:%VPS_DIR%/
scp "%LOCAL_DIR%\tsconfig.json" %VPS_USER%@%VPS_IP%:%VPS_DIR%/
scp "%LOCAL_DIR%\.env.example" %VPS_USER%@%VPS_IP%:%VPS_DIR%/

REM Copiar .env se existir (cuidado com chaves privadas!)
echo [3/4] Verificando .env...
if exist "%LOCAL_DIR%\.env" (
    echo   AVISO: Arquivo .env sera copiado com PRIVATE_KEY!
    set /p confirm="   Continuar? (S/N): "
    if /i "%confirm%"=="S" (
        scp "%LOCAL_DIR%\.env" %VPS_USER%@%VPS_IP%:%VPS_DIR%/
    ) else (
        echo   .env NAO copiado. Configure manualmente no VPS.
    )
) else (
    echo   .env nao encontrado localmente.
)

REM Executar deploy no VPS
echo [4/4] Executando deploy no VPS...
ssh %VPS_USER%@%VPS_IP% "chmod +x %VPS_DIR%/scripts/deploy-to-vps.sh && %VPS_DIR%/scripts/deploy-to-vps.sh"

echo.
echo ===============================================================
echo   UPLOAD CONCLUIDO!
echo ===============================================================
echo.
echo Para conectar ao VPS:
echo   ssh %VPS_USER%@%VPS_IP%
echo.
echo Para ver logs do bot:
echo   ssh %VPS_USER%@%VPS_IP% "journalctl -u liquidation-bot -f"
echo.
pause
