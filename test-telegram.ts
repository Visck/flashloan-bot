import dotenv from 'dotenv';
dotenv.config();

async function testTelegram() {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;

    console.log('='.repeat(50));
    console.log('TELEGRAM TEST');
    console.log('='.repeat(50));

    if (!token || !chatId) {
        console.log('ERRO: Variaveis nao configuradas');
        console.log('TELEGRAM_BOT_TOKEN:', token ? '✅ OK' : '❌ MISSING');
        console.log('TELEGRAM_CHAT_ID:', chatId ? '✅ OK' : '❌ MISSING');
        return;
    }

    console.log('TELEGRAM_BOT_TOKEN: ✅ Configurado');
    console.log('TELEGRAM_CHAT_ID: ✅ Configurado');
    console.log('');
    console.log('Enviando mensagem de teste...');

    const url = `https://api.telegram.org/bot${token}/sendMessage`;

    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: chatId,
                text: `🤖 *LIQUIDATION BOT - TEST*

✅ Telegram configurado com sucesso!

Você receberá notificações aqui quando:
• 🚀 Bot iniciar
• 🔍 Encontrar oportunidades
• 💰 Executar liquidações
• 📊 Estatísticas periódicas

_Teste enviado via Claude Code_`,
                parse_mode: 'Markdown'
            })
        });

        const data = await response.json() as { ok: boolean; description?: string };

        if (data.ok) {
            console.log('');
            console.log('✅ SUCESSO! Verifique seu Telegram!');
        } else {
            console.log('');
            console.log('❌ ERRO:', data.description);
        }
    } catch (error) {
        console.log('❌ ERRO:', error);
    }
}

testTelegram();
