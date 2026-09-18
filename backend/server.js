const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const crypto = require('crypto');
const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const nodemailer = require('nodemailer');
const Anthropic = require('@anthropic-ai/sdk');

dotenv.config();
const app = express();

// Railway fica atrás de proxy: sem isso o rate limit enxerga todo mundo como um IP só
app.set('trust proxy', 1);

const pool = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  port: process.env.DB_PORT || 3306,
  waitForConnections: true,
  connectionLimit: 10,
});

const client = new Anthropic({ apiKey: process.env.CLAUDE_API_KEY });

// ============ CONFIGURAÇÃO ============

function inteiroEntre(valor, padrao, minimo, maximo) {
  const n = parseInt(valor, 10);
  if (!Number.isFinite(n)) return padrao;
  return Math.min(Math.max(n, minimo), maximo);
}

// Inteiros validados aqui porque alguns vão direto no SQL (nunca vêm do usuário).
const CACHE_HORAS = inteiroEntre(process.env.CACHE_HORAS, 6, 1, 168);
const ANALISE_CACHE_HORAS = inteiroEntre(process.env.ANALISE_CACHE_HORAS, 24, 1, 168);
const CODIGO_CONVITE = process.env.CODIGO_CONVITE || '';
// Enquanto o pagamento não está ligado, só este email troca plano de alguém.
const EMAIL_ADMIN = String(process.env.EMAIL_ADMIN || '').trim().toLowerCase();
const DIAS_TESTE = inteiroEntre(process.env.DIAS_TESTE, 14, 1, 365);

// ============ PLANOS ============
// Cota é MENSAL, não diária: teto diário não controla custo de verdade
// (40 buscas por dia dariam mais de mil reais de custo no mês).
// Custo aproximado por busca hoje: R$ 1. Por análise: centavos.
// O cache é compartilhado entre contas, então equipe grande custa menos por pessoa.

const PLANOS = {
  teste: {
    nome: 'Teste',
    preco: 0,
    buscas_mes: 15,
    analises_mes: 10,
    alertas: 1,
    contas: 1,
    descricao: `${DIAS_TESTE} dias para experimentar`,
  },
  corretor: {
    nome: 'Corretor',
    preco: 149,
    buscas_mes: 60,
    analises_mes: 20,
    alertas: 2,
    contas: 1,
    descricao: 'Para o corretor que trabalha sozinho',
  },
  equipe: {
    nome: 'Equipe',
    preco: 497,
    buscas_mes: 250,
    analises_mes: 80,
    alertas: 8,
    contas: 5,
    descricao: 'Para equipes pequenas, cota compartilhada',
  },
  imobiliaria: {
    nome: 'Imobiliária',
    preco: 1190,
    buscas_mes: 700,
    analises_mes: 200,
    alertas: 20,
    contas: 15,
    descricao: 'Para a imobiliária inteira',
  },
};

function limitesDoPlano(plano) {
  return PLANOS[plano] || PLANOS.teste;
}

// Sem segredo fixo, todo deploy derruba os logins. Avisa alto em vez de falhar calado.
const JWT_SEGREDO = process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex');
if (!process.env.JWT_SECRET) {
  console.warn('ATENCAO: JWT_SECRET nao configurado. Usando segredo temporario.');
  console.warn('Todo mundo sera deslogado a cada deploy. Configure JWT_SECRET no Railway.');
}
if (!CODIGO_CONVITE) {
  console.warn('CODIGO_CONVITE nao configurado: cadastro de novas contas esta DESLIGADO.');
}

app.use(cors());
app.use(express.json());

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// ============ EMAIL ============
// SMTP da Hostinger, que já está pago. Sem configuração, o app funciona igual,
// só não avisa ninguém.

const SMTP_HOST = process.env.SMTP_HOST || '';
const SMTP_PORT = inteiroEntre(process.env.SMTP_PORT, 465, 1, 65535);
const SMTP_USER = process.env.SMTP_USER || '';
const SMTP_PASS = process.env.SMTP_PASS || '';
const SMTP_FROM = process.env.SMTP_FROM || SMTP_USER;
const APP_URL = process.env.APP_URL || 'https://app-imobiliario-kappa.vercel.app';

const emailLigado = Boolean(SMTP_HOST && SMTP_USER && SMTP_PASS);
let transporte = null;

if (emailLigado) {
  transporte = nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_PORT === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });
  console.log(`Email de alerta ligado via ${SMTP_HOST}:${SMTP_PORT}`);
} else {
  console.warn('SMTP nao configurado: alertas nao enviam email. Configure SMTP_HOST, SMTP_USER e SMTP_PASS.');
}

function escaparHtml(texto) {
  return String(texto || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Falha de email nunca derruba o alerta: o resultado já está salvo no app.
async function enviarEmail(para, assunto, html, texto) {
  if (!emailLigado || !para) return false;
  try {
    await transporte.sendMail({ from: SMTP_FROM, to: para, subject: assunto, text: texto, html });
    console.log(`Email enviado para ${para}: ${assunto}`);
    return true;
  } catch (error) {
    console.error('Falha ao enviar email:', error.message);
    return false;
  }
}

function montarEmailDeNovos(nomeAlerta, novos) {
  const linhas = novos.slice(0, 10).map((a) => {
    const preco = a.preco ? `R$ ${Number(a.preco).toLocaleString('pt-BR')}` : 'preço não informado';
    const onde = [a.bairro, a.cidade].filter(Boolean).join(', ');
    return { titulo: a.titulo || 'Anúncio', preco, onde, portal: a.site_origem || '', link: a.link || '' };
  });

  const texto = [
    `${novos.length} imóvel(is) novo(s) na sua busca "${nomeAlerta}".`,
    '',
    ...linhas.map((l) => `- ${l.titulo}\n  ${l.preco} · ${l.onde} · ${l.portal}\n  ${l.link}`),
    '',
    `Ver tudo no app: ${APP_URL}`,
  ].join('\n');

  const html = `
    <div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;color:#222">
      <h2 style="font-size:18px;font-weight:500;margin:0 0 4px">
        ${novos.length} imóvel(is) novo(s)
      </h2>
      <p style="color:#666;font-size:14px;margin:0 0 20px">
        Na sua busca <strong>${escaparHtml(nomeAlerta)}</strong>
      </p>
      ${linhas.map((l) => `
        <div style="border-left:3px solid #5aa9e6;padding:10px 14px;margin-bottom:12px;background:#f7f9fb">
          <div style="font-size:15px;margin-bottom:4px">${escaparHtml(l.titulo)}</div>
          <div style="font-size:14px;font-weight:bold;margin-bottom:4px">${escaparHtml(l.preco)}</div>
          <div style="color:#666;font-size:13px;margin-bottom:6px">
            ${escaparHtml(l.onde)}${l.portal ? ' · ' + escaparHtml(l.portal) : ''}
          </div>
          ${l.link ? `<a href="${escaparHtml(l.link)}" style="color:#3d8ed1;font-size:13px">Abrir anúncio</a>` : ''}
        </div>
      `).join('')}
      ${novos.length > 10 ? `<p style="color:#666;font-size:13px">E mais ${novos.length - 10} no app.</p>` : ''}
      <p style="margin-top:22px">
        <a href="${APP_URL}" style="background:#5aa9e6;color:#fff;padding:11px 20px;border-radius:6px;text-decoration:none;font-size:14px;display:inline-block">
          Abrir o Radar Imobiliário
        </a>
      </p>
      <p style="color:#999;font-size:12px;margin-top:24px">
        Você recebe este aviso porque tem uma busca agendada ativa.
        Para parar, desative o alerta ou desmarque o aviso por email no seu perfil.
      </p>
    </div>`;

  return { texto, html };
}

// ============ ERROS ============

// Detalhe do erro vai pro log, nunca pro navegador.
function falhou(res, contexto, error, status = 500) {
  console.error(`[${contexto}]`, error);
  res.status(status).json({ erro: 'Não foi possível concluir a operação. Tente de novo.' });
}

// ============ BANCO ============

async function colunaExiste(tabela, coluna) {
  const [rows] = await pool.query(
    `SELECT 1 FROM information_schema.columns
     WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ? LIMIT 1`,
    [tabela, coluna]
  );
  return rows.length > 0;
}

// Cada passo isolado: um que falha não pode impedir os seguintes.
// Já aconteceu de um índice duplicado abortar a migração inteira e derrubar o login.
async function passo(nome, fn) {
  try {
    await fn();
    return true;
  } catch (error) {
    console.error(`[migracao:${nome}] ${error.code || ''} ${error.sqlMessage || error.message || error}`);
    return false;
  }
}

// Cria/ajusta tudo sozinho no boot, sem precisar abrir o phpMyAdmin
async function prepararBanco() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS usuarios (
        id INT AUTO_INCREMENT PRIMARY KEY,
        nome_imobiliaria VARCHAR(150) NOT NULL,
        email VARCHAR(160) NOT NULL UNIQUE,
        senha_hash VARCHAR(255) NOT NULL,
        plano VARCHAR(20) NOT NULL DEFAULT 'basico',
        ativo BOOLEAN NOT NULL DEFAULT TRUE,
        criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS buscas_cache (
        id INT AUTO_INCREMENT PRIMARY KEY,
        chave CHAR(64) NOT NULL,
        criterios TEXT,
        resultado LONGTEXT NOT NULL,
        criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_chave_data (chave, criado_em)
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS analises_cache (
        id INT AUTO_INCREMENT PRIMARY KEY,
        chave CHAR(64) NOT NULL,
        resultado LONGTEXT NOT NULL,
        criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_analise_chave_data (chave, criado_em)
      )
    `);

    // Cota é por conta principal e por mês. A competência é sempre o dia 1.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS uso_mensal (
        id INT AUTO_INCREMENT PRIMARY KEY,
        conta_id INT NOT NULL,
        competencia DATE NOT NULL,
        buscas INT NOT NULL DEFAULT 0,
        analises INT NOT NULL DEFAULT 0,
        UNIQUE KEY uk_conta_competencia (conta_id, competencia)
      )
    `);

    // Anúncios que o corretor marcou: favorito, contato feito e o que deu.
    // Guarda uma cópia dos dados porque o anúncio some do portal quando vende.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS anuncios_salvos (
        id INT AUTO_INCREMENT PRIMARY KEY,
        usuario_id INT NOT NULL,
        chave CHAR(64) NOT NULL,
        titulo VARCHAR(400),
        link VARCHAR(900),
        site_origem VARCHAR(120),
        preco DECIMAL(12,2) NULL,
        bairro VARCHAR(150),
        cidade VARCHAR(150),
        dados LONGTEXT,
        favorito BOOLEAN NOT NULL DEFAULT FALSE,
        status VARCHAR(20) NULL,
        observacao TEXT,
        contatado_em TIMESTAMP NULL,
        criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        atualizado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uk_usuario_anuncio (usuario_id, chave),
        INDEX idx_salvos_usuario (usuario_id, favorito)
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS historico_buscas (
        id INT AUTO_INCREMENT PRIMARY KEY,
        usuario_id INT NOT NULL,
        criterios TEXT NOT NULL,
        resultados INT NOT NULL DEFAULT 0,
        criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_historico_usuario (usuario_id, criado_em)
      )
    `);

    // Busca agendada. Só roda quando o corretor cria e deixa ativa.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS alertas (
        id INT AUTO_INCREMENT PRIMARY KEY,
        usuario_id INT NOT NULL,
        nome VARCHAR(160) NOT NULL,
        criterios TEXT NOT NULL,
        ativo BOOLEAN NOT NULL DEFAULT TRUE,
        hora TINYINT NOT NULL DEFAULT 7,
        ultima_execucao TIMESTAMP NULL,
        ultimo_resultado LONGTEXT,
        novos LONGTEXT,
        sumidos LONGTEXT,
        erro VARCHAR(300) NULL,
        criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_alertas_usuario (usuario_id, ativo)
      )
    `);

    // Cada coluna no seu próprio passo: índice duplicado não derruba o resto.
    await passo('usuarios.conta_principal_id', async () => {
      if (!(await colunaExiste('usuarios', 'conta_principal_id'))) {
        await pool.query('ALTER TABLE usuarios ADD COLUMN conta_principal_id INT NULL');
      }
    });
    await passo('usuarios.indice_conta', async () => {
      await pool.query('ALTER TABLE usuarios ADD INDEX idx_usuarios_conta (conta_principal_id)');
    });
    await passo('usuarios.plano_expira_em', async () => {
      if (!(await colunaExiste('usuarios', 'plano_expira_em'))) {
        await pool.query('ALTER TABLE usuarios ADD COLUMN plano_expira_em DATE NULL');
      }
    });
    await passo('usuarios.status_assinatura', async () => {
      if (!(await colunaExiste('usuarios', 'status_assinatura'))) {
        await pool.query("ALTER TABLE usuarios ADD COLUMN status_assinatura VARCHAR(20) NOT NULL DEFAULT 'teste'");
      }
    });
    await passo('usuarios.periodo_teste', async () => {
      // Contas que já existiam entram no período de teste a partir de hoje.
      await pool.query(
        `UPDATE usuarios SET plano = 'teste', status_assinatura = 'teste',
         plano_expira_em = DATE_ADD(CURDATE(), INTERVAL ${DIAS_TESTE} DAY)
         WHERE plano_expira_em IS NULL`
      );
    });
    await passo('usuarios.notificar_email', async () => {
      if (!(await colunaExiste('usuarios', 'notificar_email'))) {
        await pool.query('ALTER TABLE usuarios ADD COLUMN notificar_email BOOLEAN NOT NULL DEFAULT TRUE');
      }
    });
    await passo('usuarios.email_notificacao', async () => {
      if (!(await colunaExiste('usuarios', 'email_notificacao'))) {
        await pool.query('ALTER TABLE usuarios ADD COLUMN email_notificacao VARCHAR(160) NULL');
      }
    });

    // A carteira precisa ter dono, senão uma imobiliária enxerga a da outra.
    await passo('imoveis.usuario_id', async () => {
      if (!(await colunaExiste('imoveis', 'usuario_id'))) {
        await pool.query('ALTER TABLE imoveis ADD COLUMN usuario_id INT NULL');
      }
    });
    await passo('imoveis.indice_usuario', async () => {
      await pool.query('ALTER TABLE imoveis ADD INDEX idx_imoveis_usuario (usuario_id)');
    });

    await passo('limpeza_cache', async () => {
      await pool.query('DELETE FROM buscas_cache WHERE criado_em < (NOW() - INTERVAL 7 DAY)');
      await pool.query('DELETE FROM analises_cache WHERE criado_em < (NOW() - INTERVAL 7 DAY)');
    });

    // Confere o que realmente existe: é isso que decide se o login vai funcionar.
    const faltando = [];
    for (const col of ['conta_principal_id', 'plano_expira_em', 'status_assinatura', 'notificar_email', 'email_notificacao']) {
      if (!(await colunaExiste('usuarios', col))) faltando.push(col);
    }
    if (faltando.length > 0) {
      console.error('ATENCAO: colunas ausentes em usuarios: ' + faltando.join(', '));
    } else {
      console.log('Esquema de usuarios completo.');
    }

    console.log(`Banco pronto. Cache: ${CACHE_HORAS}h. Planos: ${Object.keys(PLANOS).join(', ')}.`);
  } catch (error) {
    console.error('Falha ao preparar o banco:', error.code || '', error.sqlMessage || error.message || error);
  }
}

// ============ AUTENTICAÇÃO ============

function gerarToken(usuario) {
  return jwt.sign(
    { id: usuario.id, email: usuario.email, nome_imobiliaria: usuario.nome_imobiliaria },
    JWT_SEGREDO,
    { expiresIn: '30d' }
  );
}

async function autenticar(req, res, next) {
  const cabecalho = req.headers.authorization || '';
  const token = cabecalho.startsWith('Bearer ') ? cabecalho.slice(7) : null;
  if (!token) return res.status(401).json({ erro: 'Faça login para continuar' });

  // Token inválido é 401. Falha de banco NÃO é 401: devolver 401 aqui fazia o
  // app deslogar sozinho toda vez que o esquema estava incompleto.
  let dados;
  try {
    dados = jwt.verify(token, JWT_SEGREDO);
  } catch {
    return res.status(401).json({ erro: 'Sessão expirada. Faça login de novo.' });
  }

  try {
    // Só colunas que existem desde a primeira versão, para nunca quebrar aqui.
    const [rows] = await pool.query(
      'SELECT id, nome_imobiliaria, email, plano, ativo FROM usuarios WHERE id = ?',
      [dados.id]
    );
    if (rows.length === 0 || !rows[0].ativo) {
      return res.status(401).json({ erro: 'Conta inativa ou inexistente' });
    }
    req.usuario = rows[0];

    // Quem paga é a conta principal. Membro de equipe herda plano e cota dela.
    // Se as colunas de assinatura ainda não existem, segue com o padrão em vez de derrubar.
    let conta = { ...rows[0], plano: rows[0].plano || 'teste', plano_expira_em: null, status_assinatura: 'teste' };
    let ehDono = true;
    try {
      const [extra] = await pool.query('SELECT conta_principal_id FROM usuarios WHERE id = ?', [dados.id]);
      const contaId = (extra[0] && extra[0].conta_principal_id) || rows[0].id;
      ehDono = !(extra[0] && extra[0].conta_principal_id);
      const [contaRows] = await pool.query(
        'SELECT id, nome_imobiliaria, email, plano, plano_expira_em, status_assinatura FROM usuarios WHERE id = ?',
        [contaId]
      );
      if (contaRows[0]) conta = contaRows[0];
    } catch (error) {
      console.error('[autenticar] esquema de assinatura incompleto, usando padrao:', error.code || error.message);
    }

    req.conta = {
      ...conta,
      limites: limitesDoPlano(conta.plano),
      ehDono,
      vencida: assinaturaVencida(conta),
    };
    next();
  } catch (error) {
    console.error('[autenticar] falha ao carregar a conta:', error.code || '', error.sqlMessage || error.message);
    return res.status(503).json({ erro: 'Não foi possível validar sua conta agora. Tente de novo em instantes.' });
  }
}

function assinaturaVencida(conta) {
  if (conta.status_assinatura === 'cancelada') return true;
  if (!conta.plano_expira_em) return false;
  const hoje = new Date();
  hoje.setHours(0, 0, 0, 0);
  return new Date(conta.plano_expira_em) < hoje;
}

// Bloqueia só o que custa dinheiro. Ler o que já foi salvo continua liberado,
// senão o corretor perde acesso ao próprio histórico por causa de um boleto.
function exigirAssinatura(req, res, next) {
  if (req.conta.vencida) {
    return res.status(402).json({
      erro: 'Assinatura vencida. Renove para voltar a buscar e analisar.',
      assinatura_vencida: true,
    });
  }
  next();
}

const limitePorIp = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { erro: 'Muitas requisições. Espere alguns minutos.' },
});

const limiteLogin = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { erro: 'Muitas tentativas de login. Espere alguns minutos.' },
});

app.use('/api', limitePorIp);

// Cota mensal da conta: é o freio de mão do custo de API.
const COMPETENCIA = "DATE_FORMAT(CURDATE(), '%Y-%m-01')";

async function lerUso(contaId) {
  const [rows] = await pool.query(
    `SELECT buscas, analises FROM uso_mensal WHERE conta_id = ? AND competencia = ${COMPETENCIA}`,
    [contaId]
  );
  return rows[0] || { buscas: 0, analises: 0 };
}

async function consumirCota(contaId, campo, teto) {
  const uso = await lerUso(contaId);
  if (uso[campo] >= teto) return false;

  await pool.query(
    `INSERT INTO uso_mensal (conta_id, competencia, ${campo}) VALUES (?, ${COMPETENCIA}, 1)
     ON DUPLICATE KEY UPDATE ${campo} = ${campo} + 1`,
    [contaId]
  );
  return true;
}

// Resolve a conta pagante de um usuário. Usado fora das rotas (agendador).
async function contaDoUsuario(usuarioId) {
  const [rows] = await pool.query(
    `SELECT c.id, c.plano, c.plano_expira_em, c.status_assinatura
     FROM usuarios u
     JOIN usuarios c ON c.id = COALESCE(u.conta_principal_id, u.id)
     WHERE u.id = ?`,
    [usuarioId]
  );
  if (rows.length === 0) return null;
  return { ...rows[0], limites: limitesDoPlano(rows[0].plano), vencida: assinaturaVencida(rows[0]) };
}

// Ponto único de ativação. Ligar o Mercado Pago depois é chamar esta função
// do webhook de pagamento aprovado. Nada mais precisa mudar.
async function ativarAssinatura(contaId, plano, meses = 1) {
  if (!PLANOS[plano]) throw new Error('Plano inexistente: ' + plano);
  await pool.query(
    `UPDATE usuarios
     SET plano = ?, status_assinatura = 'ativa',
         plano_expira_em = DATE_ADD(GREATEST(COALESCE(plano_expira_em, CURDATE()), CURDATE()), INTERVAL ? MONTH)
     WHERE id = ?`,
    [plano, inteiroEntre(meses, 1, 1, 24), contaId]
  );
  console.log(`Assinatura ativada: conta ${contaId}, plano ${plano}, +${meses} mes(es)`);
}

app.post('/api/auth/registrar', limiteLogin, async (req, res) => {
  try {
    const { nome_imobiliaria, email, senha, codigo } = req.body;

    if (!CODIGO_CONVITE) {
      return res.status(403).json({ erro: 'Cadastro fechado no momento.' });
    }
    if (codigo !== CODIGO_CONVITE) {
      return res.status(403).json({ erro: 'Código de convite inválido.' });
    }
    if (!nome_imobiliaria || !email || !senha) {
      return res.status(400).json({ erro: 'Preencha nome da imobiliária, email e senha.' });
    }
    if (String(senha).length < 8) {
      return res.status(400).json({ erro: 'A senha precisa ter pelo menos 8 caracteres.' });
    }

    const emailLimpo = String(email).trim().toLowerCase();
    const [existe] = await pool.query('SELECT id FROM usuarios WHERE email = ?', [emailLimpo]);
    if (existe.length > 0) {
      return res.status(409).json({ erro: 'Já existe uma conta com esse email.' });
    }

    const senhaHash = await bcrypt.hash(String(senha), 10);
    const [result] = await pool.query(
      `INSERT INTO usuarios (nome_imobiliaria, email, senha_hash, plano, status_assinatura, plano_expira_em)
       VALUES (?, ?, ?, 'teste', 'teste', DATE_ADD(CURDATE(), INTERVAL ${DIAS_TESTE} DAY))`,
      [String(nome_imobiliaria).trim(), emailLimpo, senhaHash]
    );

    const usuario = { id: result.insertId, email: emailLimpo, nome_imobiliaria: String(nome_imobiliaria).trim() };
    res.status(201).json({ token: gerarToken(usuario), usuario });
  } catch (error) { falhou(res, 'registrar', error); }
});

app.post('/api/auth/login', limiteLogin, async (req, res) => {
  try {
    const { email, senha } = req.body;
    if (!email || !senha) return res.status(400).json({ erro: 'Informe email e senha.' });

    const emailLimpo = String(email).trim().toLowerCase();
    const [rows] = await pool.query('SELECT * FROM usuarios WHERE email = ?', [emailLimpo]);

    // Mesma resposta para email inexistente e senha errada: não entrega quem tem conta.
    if (rows.length === 0 || !rows[0].ativo) {
      return res.status(401).json({ erro: 'Email ou senha incorretos.' });
    }
    const confere = await bcrypt.compare(String(senha), rows[0].senha_hash);
    if (!confere) {
      return res.status(401).json({ erro: 'Email ou senha incorretos.' });
    }

    const usuario = { id: rows[0].id, email: rows[0].email, nome_imobiliaria: rows[0].nome_imobiliaria };
    res.json({ token: gerarToken(usuario), usuario });
  } catch (error) { falhou(res, 'login', error); }
});

app.get('/api/auth/eu', autenticar, async (req, res) => {
  try {
    let pref = [];
    try {
      [pref] = await pool.query(
        'SELECT notificar_email, email_notificacao FROM usuarios WHERE id = ?',
        [req.usuario.id]
      );
    } catch (error) {
      console.error('[eu] colunas de notificacao ausentes:', error.code || error.message);
    }
    const uso = await lerUso(req.conta.id);
    const lim = req.conta.limites;

    res.json({
      usuario: req.usuario,
      notificacoes: {
        notificar_email: pref[0] ? Boolean(pref[0].notificar_email) : true,
        email_notificacao: pref[0] ? pref[0].email_notificacao : null,
        email_ligado: emailLigado,
      },
      assinatura: {
        plano: req.conta.plano,
        plano_nome: lim.nome,
        status: req.conta.status_assinatura,
        expira_em: req.conta.plano_expira_em,
        vencida: req.conta.vencida,
        eh_dono: req.conta.ehDono,
        limites: lim,
      },
      uso_mes: {
        buscas: uso.buscas,
        buscas_restantes: Math.max(lim.buscas_mes - uso.buscas, 0),
        buscas_limite: lim.buscas_mes,
        analises: uso.analises,
        analises_restantes: Math.max(lim.analises_mes - uso.analises, 0),
        analises_limite: lim.analises_mes,
      },
    });
  } catch (error) { falhou(res, 'eu', error); }
});

// Catálogo público: a tela de planos lê daqui, não tem preço no frontend.
app.get('/api/planos', (req, res) => {
  res.json({
    planos: Object.entries(PLANOS).map(([id, p]) => ({ id, ...p })),
    dias_teste: DIAS_TESTE,
    pagamento_ligado: false,
  });
});

app.get('/api/equipe', autenticar, async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT id, nome_imobiliaria, email, ativo, criado_em FROM usuarios
       WHERE conta_principal_id = ? ORDER BY criado_em`,
      [req.conta.id]
    );
    res.json({
      membros: rows,
      limite_contas: req.conta.limites.contas,
      usadas: rows.length + 1,
      eh_dono: req.conta.ehDono,
    });
  } catch (error) { falhou(res, 'listar equipe', error); }
});

app.post('/api/equipe', autenticar, async (req, res) => {
  try {
    if (!req.conta.ehDono) return res.status(403).json({ erro: 'Só a conta principal pode adicionar corretores.' });

    const { nome, email, senha } = req.body;
    if (!nome || !email || !senha) return res.status(400).json({ erro: 'Informe nome, email e senha.' });
    if (String(senha).length < 8) return res.status(400).json({ erro: 'A senha precisa ter pelo menos 8 caracteres.' });

    const [membros] = await pool.query('SELECT COUNT(*) AS total FROM usuarios WHERE conta_principal_id = ?', [req.conta.id]);
    if (membros[0].total + 1 >= req.conta.limites.contas) {
      return res.status(403).json({
        erro: `O plano ${req.conta.limites.nome} permite ${req.conta.limites.contas} conta(s). Mude de plano para adicionar mais.`,
      });
    }

    const emailLimpo = String(email).trim().toLowerCase();
    const [existe] = await pool.query('SELECT id FROM usuarios WHERE email = ?', [emailLimpo]);
    if (existe.length > 0) return res.status(409).json({ erro: 'Já existe uma conta com esse email.' });

    const senhaHash = await bcrypt.hash(String(senha), 10);
    const [result] = await pool.query(
      'INSERT INTO usuarios (nome_imobiliaria, email, senha_hash, conta_principal_id) VALUES (?, ?, ?, ?)',
      [String(nome).trim(), emailLimpo, senhaHash, req.conta.id]
    );

    res.status(201).json({ id: result.insertId, nome_imobiliaria: String(nome).trim(), email: emailLimpo, ativo: 1 });
  } catch (error) { falhou(res, 'criar membro', error); }
});

app.delete('/api/equipe/:id', autenticar, async (req, res) => {
  try {
    if (!req.conta.ehDono) return res.status(403).json({ erro: 'Só a conta principal pode remover corretores.' });
    const [result] = await pool.query(
      'DELETE FROM usuarios WHERE id = ? AND conta_principal_id = ?',
      [req.params.id, req.conta.id]
    );
    if (result.affectedRows === 0) return res.status(404).json({ erro: 'Não encontrado' });
    res.json({ ok: true });
  } catch (error) { falhou(res, 'remover membro', error); }
});

// Checkout: fica pronto esperando o Mercado Pago. Quando ligar, é aqui que
// se cria a preferência de pagamento e se devolve a URL para o navegador.
app.post('/api/assinatura/checkout', autenticar, async (req, res) => {
  const { plano } = req.body;
  if (!PLANOS[plano]) return res.status(400).json({ erro: 'Plano inexistente.' });
  if (!req.conta.ehDono) return res.status(403).json({ erro: 'Só a conta principal pode assinar.' });

  return res.status(501).json({
    erro: 'Pagamento ainda não conectado. Fale com o suporte para ativar o plano manualmente.',
    plano,
    valor: PLANOS[plano].preco,
    pagamento_ligado: false,
  });
});

// Troca manual de plano enquanto o pagamento não está ligado.
app.post('/api/assinatura/ativar', autenticar, async (req, res) => {
  try {
    if (!EMAIL_ADMIN || req.usuario.email !== EMAIL_ADMIN) {
      return res.status(403).json({ erro: 'Sem permissão.' });
    }
    const { conta_id, plano, meses } = req.body;
    if (!PLANOS[plano]) return res.status(400).json({ erro: 'Plano inexistente.' });

    await ativarAssinatura(conta_id || req.conta.id, plano, meses || 1);
    res.json({ ok: true });
  } catch (error) { falhou(res, 'ativar assinatura', error); }
});

app.put('/api/auth/notificacoes', autenticar, async (req, res) => {
  try {
    const { notificar_email, email_notificacao } = req.body;
    const destino = String(email_notificacao || '').trim().toLowerCase();
    if (destino && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(destino)) {
      return res.status(400).json({ erro: 'Email inválido.' });
    }

    await pool.query(
      'UPDATE usuarios SET notificar_email = ?, email_notificacao = ? WHERE id = ?',
      [notificar_email === undefined ? true : Boolean(notificar_email), destino || null, req.usuario.id]
    );

    res.json({
      notificar_email: notificar_email === undefined ? true : Boolean(notificar_email),
      email_notificacao: destino || null,
      email_ligado: emailLigado,
    });
  } catch (error) { falhou(res, 'atualizar notificacoes', error); }
});

// Trocar a imobiliária. O corretor pode mudar de casa sem perder a conta e o histórico.
app.put('/api/auth/perfil', autenticar, async (req, res) => {
  try {
    const { nome_imobiliaria } = req.body;
    const nome = String(nome_imobiliaria || '').trim();
    if (nome.length < 2) return res.status(400).json({ erro: 'Informe o nome da imobiliária.' });
    if (nome.length > 150) return res.status(400).json({ erro: 'Nome muito longo.' });

    await pool.query('UPDATE usuarios SET nome_imobiliaria = ? WHERE id = ?', [nome, req.usuario.id]);

    const usuario = { ...req.usuario, nome_imobiliaria: nome };
    // Token novo porque o nome da imobiliária vai dentro dele.
    res.json({ token: gerarToken(usuario), usuario });
  } catch (error) { falhou(res, 'atualizar perfil', error); }
});

// ============ AUXILIARES ============

function extrairJSON(textoCompleto) {
  if (!textoCompleto || !textoCompleto.trim()) {
    throw new Error('IA retornou resposta vazia');
  }

  // remove cercas de markdown, se vierem
  let texto = textoCompleto.replace(/```json/gi, '').replace(/```/g, '');

  // pega do primeiro abre chaves até o último fecha chaves
  const inicio = texto.indexOf('{');
  const fim = texto.lastIndexOf('}');
  if (inicio === -1 || fim === -1) {
    throw new Error('Nenhum bloco JSON encontrado na resposta: ' + textoCompleto.slice(0, 300));
  }
  texto = texto.slice(inicio, fim + 1);

  // remove vírgulas sobrando antes de } ou ]
  texto = texto.replace(/,(\s*[}\]])/g, '$1');

  try {
    return JSON.parse(texto);
  } catch (erro) {
    console.error('Falha ao parsear JSON. Motivo:', erro.message);
    console.error('Texto que falhou:', texto.slice(0, 1500));
    throw new Error('Resposta da IA veio malformada: ' + erro.message);
  }
}

// Detecta se a URL aponta para um anúncio específico ou só para uma página de listagem
function ehLinkDeAnuncio(url) {
  if (!url || typeof url !== 'string') return false;
  try {
    const caminho = new URL(url).pathname;
    const segmentos = caminho.split('/').filter(Boolean);
    const temIdLongo = /\d{6,}/.test(caminho);
    const temSlugDetalhado = segmentos.some((s) => s.length > 25);
    return temIdLongo || temSlugDetalhado || segmentos.length >= 5;
  } catch {
    return false;
  }
}

// Mesmos critérios, escritos de formas diferentes, precisam gerar a mesma chave.
// "Águas Claras", "aguas claras" e " AGUAS CLARAS " são a mesma busca.
function normalizar(valor) {
  if (valor === null || valor === undefined) return '';
  return String(valor)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

const CAMPOS_BUSCA = [
  'cidade', 'bairro', 'tipo', 'preco_min', 'preco_max',
  'quartos_min', 'banheiros_min', 'vagas_min', 'area_min', 'area_max', 'detalhes',
];

function somenteCriterios(entrada) {
  const saida = {};
  CAMPOS_BUSCA.forEach((campo) => {
    const v = entrada[campo];
    if (v !== undefined && v !== null && String(v).trim() !== '') saida[campo] = v;
  });
  return saida;
}

function chaveDaBusca(criterios) {
  const base = CAMPOS_BUSCA.map((campo) => `${campo}=${normalizar(criterios[campo])}`).join('|');
  return crypto.createHash('sha256').update(base).digest('hex');
}

// Identidade do anúncio. O link é o melhor identificador; sem ele, título + portal.
function chaveDoAnuncio(anuncio) {
  const base = anuncio.link
    ? normalizar(anuncio.link)
    : `${normalizar(anuncio.site_origem)}|${normalizar(anuncio.titulo)}`;
  return crypto.createHash('sha256').update(base).digest('hex');
}

// ============ CACHE DE BUSCAS ============

async function lerDoCache(chave) {
  try {
    const [rows] = await pool.query(
      `SELECT resultado, criado_em FROM buscas_cache
       WHERE chave = ? AND criado_em > (NOW() - INTERVAL ${CACHE_HORAS} HOUR)
       ORDER BY criado_em DESC LIMIT 1`,
      [chave]
    );
    if (rows.length === 0) return null;
    return { anuncios: JSON.parse(rows[0].resultado), buscado_em: rows[0].criado_em };
  } catch (error) {
    console.error('Falha ao ler cache (seguindo sem ele):', error.message);
    return null;
  }
}

async function gravarNoCache(chave, criterios, anuncios) {
  try {
    await pool.query(
      'INSERT INTO buscas_cache (chave, criterios, resultado) VALUES (?, ?, ?)',
      [chave, JSON.stringify(criterios), JSON.stringify(anuncios)]
    );
  } catch (error) {
    console.error('Falha ao gravar cache (resultado foi entregue mesmo assim):', error.message);
  }
}

async function registrarHistorico(usuarioId, criterios, resultados) {
  try {
    await pool.query(
      'INSERT INTO historico_buscas (usuario_id, criterios, resultados) VALUES (?, ?, ?)',
      [usuarioId, JSON.stringify(somenteCriterios(criterios)), resultados]
    );
    // Mantém só as 15 últimas por usuário.
    await pool.query(
      `DELETE FROM historico_buscas
       WHERE usuario_id = ? AND id NOT IN (
         SELECT id FROM (
           SELECT id FROM historico_buscas WHERE usuario_id = ? ORDER BY criado_em DESC LIMIT 15
         ) recentes
       )`,
      [usuarioId, usuarioId]
    );
  } catch (error) {
    console.error('Falha ao registrar historico (busca foi entregue mesmo assim):', error.message);
  }
}

// ============ CONSULTA AOS PORTAIS ============
// Separada das rotas porque a busca agendada chama a mesma função.

async function consultarPortais(criterios) {
  const { cidade, bairro, tipo, preco_min, preco_max, quartos_min, banheiros_min, vagas_min, area_min, area_max, detalhes } = criterios;

  const linhasCriterios = [
    `Localização: ${bairro}${cidade ? `, ${cidade}` : ''}`,
    tipo && `Tipo: ${tipo}`,
    preco_min && `Preço mínimo: R$ ${preco_min}`,
    preco_max && `Preço máximo: R$ ${preco_max}`,
    quartos_min && `Mínimo de ${quartos_min} quarto(s)`,
    banheiros_min && `Mínimo de ${banheiros_min} banheiro(s)`,
    vagas_min && `Mínimo de ${vagas_min} vaga(s) de garagem`,
    area_min && `Área mínima: ${area_min}m²`,
    area_max && `Área máxima: ${area_max}m²`,
    detalhes && `Preferências adicionais (use para priorizar, nunca para descartar): ${detalhes}`,
  ].filter(Boolean).join('\n');

  const hoje = new Date().toLocaleDateString('pt-BR', { day: '2-digit', month: 'long', year: 'numeric' });

  const prompt = `Você é um assistente especializado em buscar imóveis à venda no Brasil. Hoje é ${hoje}.

Encontre anúncios REAIS e ATIVOS de imóveis à venda em portais como OLX, Viva Real, Zap Imóveis, Imovelweb, DF Imóveis, MGF Imóveis e QuintoAndar, que combinem com estes critérios:

${linhasCriterios}

Método obrigatório de trabalho:
1. Use web_search para localizar as páginas de resultado dos portais que atendam aos critérios.
2. Use web_fetch para ABRIR essas páginas de listagem e extrair de dentro delas os anúncios individuais, com a URL específica de cada imóvel, o preço e as características reais.
3. Se útil, use web_fetch novamente na página do anúncio individual para confirmar preço, características e telefone de contato.

Priorize portais que publicam o telefone do anunciante na própria página, porque o objetivo é permitir o contato imediato.

Regras rígidas sobre o campo "link":
- Deve ser a URL da PÁGINA DO ANÚNCIO ESPECÍFICO daquele imóvel, com identificador ou slug próprio do imóvel.
- NUNCA use a URL de uma página de busca, listagem, categoria ou home do portal. Exemplos do que é PROIBIDO: /venda/df/brasilia/apartamento, /imoveis/venda, qualquer URL com parâmetros de filtro.
- Se você não conseguir obter a URL do anúncio individual, coloque "link": null. Não preencha com a página de listagem.

Demais regras:
- Extraia os dados do anúncio real. Não estime, não arredonde, não invente valores.
- Não repita o mesmo imóvel mais de uma vez.
- Marque "aceita_parceria" como true apenas se o anúncio disser explicitamente que aceita parceria ou comissão com corretores. Marque false apenas se disser explicitamente que não aceita. Caso contrário, null.
- Ordene do mais barato para o mais caro.
- Se não encontrar nenhum anúncio real correspondente, retorne a lista vazia. Nunca invente anúncios.

Traga o maior número possível de anúncios reais que atendam aos critérios, até 20. Não pare em poucos resultados se houver mais disponíveis nos portais. Nunca descarte um anúncio apenas porque não conseguiu confirmar as preferências adicionais no texto do anúncio.

Responda APENAS com um bloco JSON (sem texto antes ou depois, sem markdown):
{
  "anuncios": [
    {
      "titulo": "título do anúncio",
      "preco": número (só o valor, sem R$),
      "bairro": "bairro",
      "cidade": "cidade",
      "tipo": "apartamento/casa/terreno/comercial",
      "quartos": número ou null,
      "banheiros": número ou null,
      "vagas": número ou null,
      "area_m2": número ou null,
      "link": "URL direta do anúncio individual, ou null",
      "site_origem": "nome do site",
      "telefone": "telefone se disponível, senão null",
      "aceita_parceria": true, false, ou null
    }
  ]
}`;

  const message = await client.messages.create({
    model: 'claude-sonnet-5',
    max_tokens: 16000,
    tools: [
      { type: 'web_search_20250305', name: 'web_search', max_uses: 6 },
      {
        type: 'web_fetch_20250910',
        name: 'web_fetch',
        max_uses: 10,
        max_content_tokens: 6000,
      },
    ],
    messages: [{ role: 'user', content: prompt }],
  });

  const textoCompleto = message.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');

  if (process.env.DEBUG_BUSCA === '1') {
    console.log('=== DIAGNOSTICO BUSCA ===');
    console.log('stop_reason:', message.stop_reason);
    console.log('tipos de bloco:', message.content.map((b) => b.type).join(', '));
    console.log('tamanho do texto:', textoCompleto.length);
    console.log('resposta bruta:', textoCompleto.slice(0, 2000));
    console.log('=========================');
  }

  const resposta = extrairJSON(textoCompleto);

  return (resposta.anuncios || []).map((a) => ({
    ...a,
    link_direto: ehLinkDeAnuncio(a.link),
    link: ehLinkDeAnuncio(a.link) ? a.link : null,
  }));
}

// ============ ANÚNCIOS SALVOS E HISTÓRICO ============

const STATUS_VALIDOS = ['contatado', 'respondeu', 'aceita_parceria', 'recusou', 'sem_resposta'];

app.get('/api/salvos', autenticar, async (req, res) => {
  try {
    let query = 'SELECT * FROM anuncios_salvos WHERE usuario_id = ?';
    const params = [req.usuario.id];
    if (req.query.favorito === '1') query += ' AND favorito = TRUE';
    if (req.query.status && STATUS_VALIDOS.includes(req.query.status)) {
      query += ' AND status = ?';
      params.push(req.query.status);
    }
    query += ' ORDER BY atualizado_em DESC LIMIT 200';

    const [rows] = await pool.query(query, params);
    res.json(rows.map((r) => ({ ...r, dados: r.dados ? JSON.parse(r.dados) : null })));
  } catch (error) { falhou(res, 'listar salvos', error); }
});

// Cria ou atualiza. Só mexe no que veio no corpo, o resto fica como estava.
app.post('/api/salvos', autenticar, async (req, res) => {
  try {
    const { anuncio, favorito, status, observacao } = req.body;
    if (!anuncio || (!anuncio.titulo && !anuncio.link)) {
      return res.status(400).json({ erro: 'Anúncio inválido' });
    }
    if (status !== undefined && status !== null && !STATUS_VALIDOS.includes(status)) {
      return res.status(400).json({ erro: 'Status inválido' });
    }

    const chave = chaveDoAnuncio(anuncio);

    await pool.query(
      `INSERT INTO anuncios_salvos
         (usuario_id, chave, titulo, link, site_origem, preco, bairro, cidade, dados, favorito, status, observacao, contatado_em)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${status === 'contatado' ? 'NOW()' : 'NULL'})
       ON DUPLICATE KEY UPDATE
         dados = VALUES(dados),
         preco = VALUES(preco),
         favorito = ${favorito === undefined ? 'favorito' : 'VALUES(favorito)'},
         status = ${status === undefined ? 'status' : 'VALUES(status)'},
         observacao = ${observacao === undefined ? 'observacao' : 'VALUES(observacao)'},
         contatado_em = ${status === 'contatado' ? 'NOW()' : 'contatado_em'}`,
      [
        req.usuario.id,
        chave,
        (anuncio.titulo || '').slice(0, 400),
        (anuncio.link || '').slice(0, 900) || null,
        (anuncio.site_origem || '').slice(0, 120),
        anuncio.preco ? parseFloat(anuncio.preco) : null,
        (anuncio.bairro || '').slice(0, 150),
        (anuncio.cidade || '').slice(0, 150),
        JSON.stringify(anuncio),
        favorito === undefined ? false : Boolean(favorito),
        status === undefined ? null : status,
        observacao === undefined ? null : observacao,
      ]
    );

    const [rows] = await pool.query(
      'SELECT * FROM anuncios_salvos WHERE usuario_id = ? AND chave = ?',
      [req.usuario.id, chave]
    );
    const salvo = rows[0];
    res.json({ ...salvo, dados: salvo.dados ? JSON.parse(salvo.dados) : null });
  } catch (error) { falhou(res, 'salvar anuncio', error); }
});

app.delete('/api/salvos/:chave', autenticar, async (req, res) => {
  try {
    const [result] = await pool.query(
      'DELETE FROM anuncios_salvos WHERE usuario_id = ? AND chave = ?',
      [req.usuario.id, req.params.chave]
    );
    if (result.affectedRows === 0) return res.status(404).json({ erro: 'Não encontrado' });
    res.json({ ok: true });
  } catch (error) { falhou(res, 'remover salvo', error); }
});

app.get('/api/historico', autenticar, async (req, res) => {
  try {
    const [rows] = await pool.query(
      'SELECT id, criterios, resultados, criado_em FROM historico_buscas WHERE usuario_id = ? ORDER BY criado_em DESC LIMIT 15',
      [req.usuario.id]
    );
    res.json(rows.map((r) => ({ ...r, criterios: JSON.parse(r.criterios) })));
  } catch (error) { falhou(res, 'listar historico', error); }
});

// ============ RESUMO DO DIA ============
// Tela de abertura: o que exige ação hoje, sem ele precisar procurar.

const DIAS_SEM_RESPOSTA = inteiroEntre(process.env.DIAS_SEM_RESPOSTA, 3, 1, 60);
const DIAS_PARCERIA_PARADA = inteiroEntre(process.env.DIAS_PARCERIA_PARADA, 7, 1, 90);

function salvoParaJson(row) {
  return { ...row, dados: row.dados ? JSON.parse(row.dados) : null };
}

app.get('/api/resumo', autenticar, async (req, res) => {
  try {
    const id = req.usuario.id;

    const [alertasAtivos] = await pool.query(
      'SELECT id, nome, novos, ultima_execucao FROM alertas WHERE usuario_id = ? AND ativo = TRUE ORDER BY ultima_execucao DESC',
      [id]
    );

    // Contatou e ninguém respondeu: é o follow-up que costuma ser esquecido.
    const [semResposta] = await pool.query(
      `SELECT * FROM anuncios_salvos
       WHERE usuario_id = ? AND status = 'contatado'
         AND contatado_em IS NOT NULL
         AND contatado_em < (NOW() - INTERVAL ${DIAS_SEM_RESPOSTA} DAY)
       ORDER BY contatado_em ASC LIMIT 20`,
      [id]
    );

    // Aceitou parceria e parou: é dinheiro esfriando na mesa.
    const [parceriaParada] = await pool.query(
      `SELECT * FROM anuncios_salvos
       WHERE usuario_id = ? AND status = 'aceita_parceria'
         AND atualizado_em < (NOW() - INTERVAL ${DIAS_PARCERIA_PARADA} DAY)
       ORDER BY atualizado_em ASC LIMIT 20`,
      [id]
    );

    // Favoritou e nunca chamou ninguém.
    const [favoritosSemContato] = await pool.query(
      `SELECT * FROM anuncios_salvos
       WHERE usuario_id = ? AND favorito = TRUE AND status IS NULL
       ORDER BY criado_em DESC LIMIT 20`,
      [id]
    );

    const usoMes = await lerUso(req.conta.id);

    // Números do funil: favoritou, contatou, responderam, fecharam parceria.
    const [numeros] = await pool.query(
      `SELECT
         COUNT(*) AS salvos,
         SUM(favorito = TRUE) AS favoritos,
         SUM(status IS NOT NULL) AS contatados,
         SUM(status IN ('respondeu','aceita_parceria','recusou')) AS responderam,
         SUM(status = 'aceita_parceria') AS parcerias
       FROM anuncios_salvos WHERE usuario_id = ?`,
      [id]
    );
    const n = numeros[0] || {};

    const [alertasTotais] = await pool.query(
      'SELECT COUNT(*) AS total, SUM(ativo = TRUE) AS ativos FROM alertas WHERE usuario_id = ?',
      [id]
    );

    const novosPorAlerta = alertasAtivos
      .map((a) => ({
        id: a.id,
        nome: a.nome,
        ultima_execucao: a.ultima_execucao,
        novos: a.novos ? JSON.parse(a.novos) : [],
      }))
      .filter((a) => a.novos.length > 0);

    res.json({
      novos_por_alerta: novosPorAlerta,
      total_novos: novosPorAlerta.reduce((s, a) => s + a.novos.length, 0),
      sem_resposta: semResposta.map(salvoParaJson),
      parceria_parada: parceriaParada.map(salvoParaJson),
      favoritos_sem_contato: favoritosSemContato.map(salvoParaJson),
      alertas_ativos: alertasAtivos.length,
      dias_sem_resposta: DIAS_SEM_RESPOSTA,
      dias_parceria_parada: DIAS_PARCERIA_PARADA,
      assinatura_vencida: req.conta.vencida,
      numeros: {
        salvos: Number(n.salvos || 0),
        favoritos: Number(n.favoritos || 0),
        contatados: Number(n.contatados || 0),
        responderam: Number(n.responderam || 0),
        parcerias: Number(n.parcerias || 0),
        alertas_total: Number(alertasTotais[0] ? alertasTotais[0].total : 0),
        alertas_ativos_n: Number(alertasTotais[0] ? alertasTotais[0].ativos || 0 : 0),
      },
      uso_mes: {
        buscas: usoMes.buscas,
        buscas_restantes: Math.max(req.conta.limites.buscas_mes - usoMes.buscas, 0),
        buscas_limite: req.conta.limites.buscas_mes,
      },
    });
  } catch (error) { falhou(res, 'resumo do dia', error); }
});

// ============ CARTEIRA DE IMÓVEIS (do corretor logado) ============

app.get('/api/imoveis', autenticar, async (req, res) => {
  try {
    const { bairro, tipo, preco_min, preco_max } = req.query;
    let query = 'SELECT * FROM imoveis WHERE status = ? AND usuario_id = ?';
    let params = ['ativo', req.usuario.id];
    if (bairro && bairro.trim()) { query += ' AND bairro LIKE ?'; params.push(`%${bairro}%`); }
    if (tipo && tipo.trim()) { query += ' AND tipo = ?'; params.push(tipo); }
    if (preco_min) { query += ' AND preco >= ?'; params.push(parseFloat(preco_min)); }
    if (preco_max) { query += ' AND preco <= ?'; params.push(parseFloat(preco_max)); }
    query += ' ORDER BY criado_em DESC';
    const [rows] = await pool.query(query, params);
    res.json(rows);
  } catch (error) { falhou(res, 'listar imoveis', error); }
});

app.get('/api/imoveis/:id', autenticar, async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM imoveis WHERE id = ? AND usuario_id = ?', [req.params.id, req.usuario.id]);
    if (rows.length === 0) return res.status(404).json({ erro: 'Não encontrado' });
    res.json(rows[0]);
  } catch (error) { falhou(res, 'ver imovel', error); }
});

app.post('/api/imoveis', autenticar, async (req, res) => {
  try {
    const { titulo, preco, bairro, tipo, quartos, banheiros, area_m2, descricao, contato_telefone, contato_email } = req.body;
    if (!titulo || !preco || !bairro) return res.status(400).json({ erro: 'Campos obrigatórios: título, preço, bairro' });
    const [result] = await pool.query(
      `INSERT INTO imoveis (usuario_id, titulo, preco, bairro, tipo, quartos, banheiros, area_m2, descricao, contato_telefone, contato_email)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [req.usuario.id, titulo, parseFloat(preco), bairro, tipo, quartos || null, banheiros || null, area_m2 || null, descricao, contato_telefone, contato_email]
    );
    const [rows] = await pool.query('SELECT * FROM imoveis WHERE id = ?', [result.insertId]);
    res.status(201).json(rows[0]);
  } catch (error) { falhou(res, 'criar imovel', error); }
});

app.delete('/api/imoveis/:id', autenticar, async (req, res) => {
  try {
    const [result] = await pool.query('DELETE FROM imoveis WHERE id = ? AND usuario_id = ?', [req.params.id, req.usuario.id]);
    if (result.affectedRows === 0) return res.status(404).json({ erro: 'Não encontrado' });
    res.json({ ok: true });
  } catch (error) { falhou(res, 'remover imovel', error); }
});

// ============ ANÁLISE DE PREÇO ============

async function analisarPreco(im) {
  const hoje = new Date().toLocaleDateString('pt-BR', { day: '2-digit', month: 'long', year: 'numeric' });

  const prompt = `Você é um especialista em mercado imobiliário brasileiro. Hoje é ${hoje}.

Pesquise na web anúncios REAIS, ATIVOS e ATUAIS de imóveis à venda no bairro "${im.bairro}" (mesma cidade/região), comparáveis em tipo, tamanho e faixa de preço, para embasar sua análise com dados de mercado reais e recentes.

Imóvel a ser analisado:
Título: ${im.titulo}
Preço: R$ ${Number(im.preco).toLocaleString('pt-BR')}
Bairro: ${im.bairro}
Tipo: ${im.tipo || 'não informado'}
Quartos: ${im.quartos || 'não informado'}
Banheiros: ${im.banheiros || 'não informado'}
Área: ${im.area_m2 ? im.area_m2 + 'm²' : 'não informado'}
Descrição: ${im.descricao || 'sem descrição'}

Instruções importantes:
- Baseie a análise exclusivamente em dados reais encontrados na pesquisa. Não invente preços de referência.
- Se encontrar poucos ou nenhum comparável real, diga isso claramente no resumo e reduza a confiança da análise (não force uma conclusão).
- Considere o preço por m² da região ao avaliar se o imóvel está caro, barato ou justo.
- "tempo_venda" deve refletir a velocidade típica de giro de imóveis parecidos nessa região, com base no que encontrar.

Ao final, responda APENAS com um bloco JSON (sem texto antes ou depois, sem markdown) exatamente neste formato:
{
  "resumo": "Análise breve em 2-3 frases, citando os comparáveis reais encontrados (site/preço) que embasaram a conclusão",
  "score": número entre 0 e 100,
  "parecer": "Caro", "Barato", ou "Justo",
  "tempo_venda": "15-30 dias" ou "30-60 dias" ou "60+ dias",
  "preco_sugestao": número ou null,
  "oportunidade": true ou false
}`;

  const message = await client.messages.create({
    model: 'claude-sonnet-5',
    max_tokens: 6000,
    tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 3 }],
    messages: [{ role: 'user', content: prompt }],
  });

  const textoCompleto = message.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
  return extrairJSON(textoCompleto);
}

// O mesmo imóvel analisado duas vezes no mesmo dia dá o mesmo parecer.
// Não faz sentido pagar de novo por isso.
function chaveDaAnalise(im) {
  const base = [im.titulo, im.preco, im.bairro, im.tipo, im.quartos, im.banheiros, im.area_m2]
    .map(normalizar)
    .join('|');
  return crypto.createHash('sha256').update(base).digest('hex');
}

// Ordem que importa: cache primeiro, cota depois, IA por último.
// Assim resultado guardado nunca consome a cota diária do corretor.
async function obterAnalise(conta, im) {
  const chave = chaveDaAnalise(im);

  try {
    const [rows] = await pool.query(
      `SELECT resultado, criado_em FROM analises_cache
       WHERE chave = ? AND criado_em > (NOW() - INTERVAL ${ANALISE_CACHE_HORAS} HOUR)
       ORDER BY criado_em DESC LIMIT 1`,
      [chave]
    );
    if (rows.length > 0) {
      return { ok: true, resposta: { ...JSON.parse(rows[0].resultado), do_cache: true, analisado_em: rows[0].criado_em } };
    }
  } catch (error) {
    console.error('Falha ao ler cache de analise (seguindo sem ele):', error.message);
  }

  const temCota = await consumirCota(conta.id, 'analises', conta.limites.analises_mes);
  if (!temCota) {
    return {
      ok: false,
      status: 429,
      erro: `Você usou as ${conta.limites.analises_mes} análises do mês no plano ${conta.limites.nome}.`,
    };
  }

  const resposta = await analisarPreco(im);

  try {
    await pool.query('INSERT INTO analises_cache (chave, resultado) VALUES (?, ?)', [chave, JSON.stringify(resposta)]);
  } catch (error) {
    console.error('Falha ao gravar cache de analise (resultado foi entregue):', error.message);
  }

  return { ok: true, resposta: { ...resposta, do_cache: false, analisado_em: new Date() } };
}

app.post('/api/imoveis/:id/analisar', autenticar, exigirAssinatura, async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM imoveis WHERE id = ? AND usuario_id = ?', [req.params.id, req.usuario.id]);
    if (rows.length === 0) return res.status(404).json({ erro: 'Não encontrado' });

    const im = rows[0];
    const r = await obterAnalise(req.conta, {
      titulo: im.titulo, preco: im.preco, bairro: im.bairro, tipo: im.tipo,
      quartos: im.quartos, banheiros: im.banheiros, area_m2: im.area_m2, descricao: im.descricao,
    });
    if (!r.ok) return res.status(r.status).json({ erro: r.erro });

    await pool.query(
      'INSERT INTO analises_ia (imovel_id, resumo, score, preco_sugestao) VALUES (?, ?, ?, ?)',
      [req.params.id, r.resposta.resumo, r.resposta.score, r.resposta.preco_sugestao]
    );

    res.json(r.resposta);
  } catch (error) { falhou(res, 'analisar imovel', error); }
});

app.get('/api/imoveis/:id/analise', autenticar, async (req, res) => {
  try {
    const [dono] = await pool.query('SELECT id FROM imoveis WHERE id = ? AND usuario_id = ?', [req.params.id, req.usuario.id]);
    if (dono.length === 0) return res.status(404).json({ erro: 'Não encontrado' });
    const [rows] = await pool.query(
      'SELECT * FROM analises_ia WHERE imovel_id = ? ORDER BY data_analise DESC LIMIT 1',
      [req.params.id]
    );
    res.json(rows[0] || {});
  } catch (error) { falhou(res, 'ver analise', error); }
});

// Análise avulsa: recebe os dados direto no corpo, sem precisar estar salvo no banco
app.post('/api/analisar-avulso', autenticar, exigirAssinatura, async (req, res) => {
  try {
    const { titulo, preco, bairro, tipo, quartos, banheiros, area_m2, descricao } = req.body;
    if (!titulo || !preco || !bairro) return res.status(400).json({ erro: 'Dados insuficientes para análise' });

    const r = await obterAnalise(req.conta, { titulo, preco, bairro, tipo, quartos, banheiros, area_m2, descricao });
    if (!r.ok) return res.status(r.status).json({ erro: r.erro });
    res.json(r.resposta);
  } catch (error) { falhou(res, 'analise avulsa', error); }
});

// ============ BUSCA ============

app.post('/api/buscar-anuncios', autenticar, exigirAssinatura, async (req, res) => {
  try {
    const entrada = { ...req.query, ...req.body };
    const criterios = somenteCriterios(entrada);
    if (!criterios.bairro) return res.status(400).json({ erro: 'Informe o bairro para buscar' });

    const chave = chaveDaBusca(criterios);
    const forcar = entrada.forcar;
    const ignorarCache = forcar === '1' || forcar === 1 || forcar === true || forcar === 'true';

    // Cache não consome cota: resultado salvo não custa API.
    if (!ignorarCache) {
      const salvo = await lerDoCache(chave);
      if (salvo) {
        console.log(`Cache HIT ${chave.slice(0, 8)} (${criterios.bairro}), nenhuma chamada de IA`);
        await registrarHistorico(req.usuario.id, criterios, salvo.anuncios.length);
        return res.json({ anuncios: salvo.anuncios, do_cache: true, buscado_em: salvo.buscado_em });
      }
    }

    const temCota = await consumirCota(req.conta.id, 'buscas', req.conta.limites.buscas_mes);
    if (!temCota) {
      return res.status(429).json({
        erro: `Você usou as ${req.conta.limites.buscas_mes} buscas do mês no plano ${req.conta.limites.nome}. A cota volta no dia 1.`,
        cota_esgotada: true,
      });
    }

    console.log(`Cache MISS ${chave.slice(0, 8)} (${criterios.bairro}), consultando a IA`);
    const anuncios = await consultarPortais(criterios);

    // só vale guardar busca que achou alguma coisa
    if (anuncios.length > 0) await gravarNoCache(chave, criterios, anuncios);
    await registrarHistorico(req.usuario.id, criterios, anuncios.length);

    res.json({ anuncios, do_cache: false, buscado_em: new Date() });
  } catch (error) { falhou(res, 'buscar anuncios', error); }
});

// ============ BUSCA AGENDADA (ALERTAS) ============
// Nada roda por conta própria: o corretor cria o alerta e deixa ativo.
// Alerta desativado nunca consulta a IA e nunca gasta nada.

function alertaParaJson(row) {
  return {
    ...row,
    criterios: row.criterios ? JSON.parse(row.criterios) : {},
    ultimo_resultado: row.ultimo_resultado ? JSON.parse(row.ultimo_resultado) : [],
    novos: row.novos ? JSON.parse(row.novos) : [],
    sumidos: row.sumidos ? JSON.parse(row.sumidos) : [],
    ativo: Boolean(row.ativo),
  };
}

app.get('/api/alertas', autenticar, async (req, res) => {
  try {
    const [rows] = await pool.query(
      'SELECT * FROM alertas WHERE usuario_id = ? ORDER BY criado_em DESC',
      [req.usuario.id]
    );
    res.json(rows.map(alertaParaJson));
  } catch (error) { falhou(res, 'listar alertas', error); }
});

app.post('/api/alertas', autenticar, async (req, res) => {
  try {
    const { nome, criterios, hora } = req.body;
    const limpos = somenteCriterios(criterios || {});
    if (!limpos.bairro) return res.status(400).json({ erro: 'O alerta precisa pelo menos do bairro.' });

    const [contagem] = await pool.query(
      `SELECT COUNT(*) AS total FROM alertas a
       JOIN usuarios u ON u.id = a.usuario_id
       WHERE COALESCE(u.conta_principal_id, u.id) = ?`,
      [req.conta.id]
    );
    if (contagem[0].total >= req.conta.limites.alertas) {
      return res.status(403).json({
        erro: `O plano ${req.conta.limites.nome} permite ${req.conta.limites.alertas} busca(s) agendada(s). Apague uma ou mude de plano.`,
      });
    }

    const nomeFinal = String(nome || '').trim() || `${limpos.bairro}${limpos.cidade ? ', ' + limpos.cidade : ''}`;

    const [result] = await pool.query(
      'INSERT INTO alertas (usuario_id, nome, criterios, hora, ativo) VALUES (?, ?, ?, ?, TRUE)',
      [req.usuario.id, nomeFinal.slice(0, 160), JSON.stringify(limpos), inteiroEntre(hora, 7, 0, 23)]
    );

    const [rows] = await pool.query('SELECT * FROM alertas WHERE id = ?', [result.insertId]);
    res.status(201).json(alertaParaJson(rows[0]));
  } catch (error) { falhou(res, 'criar alerta', error); }
});

app.put('/api/alertas/:id', autenticar, async (req, res) => {
  try {
    const [dono] = await pool.query('SELECT id FROM alertas WHERE id = ? AND usuario_id = ?', [req.params.id, req.usuario.id]);
    if (dono.length === 0) return res.status(404).json({ erro: 'Não encontrado' });

    const { nome, ativo, hora } = req.body;
    const campos = [];
    const valores = [];
    if (nome !== undefined) { campos.push('nome = ?'); valores.push(String(nome).trim().slice(0, 160)); }
    if (ativo !== undefined) { campos.push('ativo = ?'); valores.push(Boolean(ativo)); }
    if (hora !== undefined) { campos.push('hora = ?'); valores.push(inteiroEntre(hora, 7, 0, 23)); }
    if (campos.length === 0) return res.status(400).json({ erro: 'Nada para alterar' });

    valores.push(req.params.id);
    await pool.query(`UPDATE alertas SET ${campos.join(', ')} WHERE id = ?`, valores);

    const [rows] = await pool.query('SELECT * FROM alertas WHERE id = ?', [req.params.id]);
    res.json(alertaParaJson(rows[0]));
  } catch (error) { falhou(res, 'atualizar alerta', error); }
});

app.delete('/api/alertas/:id', autenticar, async (req, res) => {
  try {
    const [result] = await pool.query('DELETE FROM alertas WHERE id = ? AND usuario_id = ?', [req.params.id, req.usuario.id]);
    if (result.affectedRows === 0) return res.status(404).json({ erro: 'Não encontrado' });
    res.json({ ok: true });
  } catch (error) { falhou(res, 'remover alerta', error); }
});

// Rodar na hora, sem esperar o horário. Consome cota como qualquer busca.
app.post('/api/alertas/:id/rodar', autenticar, exigirAssinatura, async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM alertas WHERE id = ? AND usuario_id = ?', [req.params.id, req.usuario.id]);
    if (rows.length === 0) return res.status(404).json({ erro: 'Não encontrado' });

    const temCota = await consumirCota(req.conta.id, 'buscas', req.conta.limites.buscas_mes);
    if (!temCota) {
      return res.status(429).json({ erro: `Você usou as ${req.conta.limites.buscas_mes} buscas do mês.` });
    }

    const atualizado = await rodarAlerta(rows[0]);
    res.json(alertaParaJson(atualizado));
  } catch (error) { falhou(res, 'rodar alerta', error); }
});

async function avisarPorEmail(alerta, novos) {
  if (novos.length === 0) return;
  try {
    const [rows] = await pool.query(
      'SELECT email, email_notificacao, notificar_email FROM usuarios WHERE id = ?',
      [alerta.usuario_id]
    );
    if (rows.length === 0 || !rows[0].notificar_email) return;

    const destino = rows[0].email_notificacao || rows[0].email;
    const { texto, html } = montarEmailDeNovos(alerta.nome, novos);
    const assunto = novos.length === 1
      ? `1 imóvel novo em ${alerta.nome}`
      : `${novos.length} imóveis novos em ${alerta.nome}`;
    await enviarEmail(destino, assunto, html, texto);
  } catch (error) {
    console.error('Falha ao avisar por email:', error.message);
  }
}

// Compara com a execução anterior. É daqui que sai o "apareceu imóvel novo".
// notificar = false quando ele mesmo clicou "rodar agora": está olhando a tela.
async function rodarAlerta(alerta, notificar = false) {
  const criterios = JSON.parse(alerta.criterios);
  const anteriores = alerta.ultimo_resultado ? JSON.parse(alerta.ultimo_resultado) : [];
  const chavesAntigas = new Set(anteriores.map(chaveDoAnuncio));

  try {
    // Alerta sempre busca fresco: o objetivo é justamente detectar mudança.
    const anuncios = await consultarPortais(criterios);
    const chavesNovas = new Set(anuncios.map(chaveDoAnuncio));

    const novos = anuncios.filter((a) => !chavesAntigas.has(chaveDoAnuncio(a)));
    // Sumiu do portal costuma significar vendido ou retirado.
    const sumidos = anteriores.filter((a) => !chavesNovas.has(chaveDoAnuncio(a)));

    // Alimenta o cache para a busca manual do corretor sair instantânea depois.
    if (anuncios.length > 0) await gravarNoCache(chaveDaBusca(criterios), criterios, anuncios);

    await pool.query(
      `UPDATE alertas SET ultimo_resultado = ?, novos = ?, sumidos = ?, ultima_execucao = NOW(), erro = NULL WHERE id = ?`,
      [
        JSON.stringify(anuncios),
        JSON.stringify(anteriores.length === 0 ? [] : novos),
        JSON.stringify(sumidos),
        alerta.id,
      ]
    );
    console.log(`Alerta ${alerta.id} rodou: ${anuncios.length} anuncios, ${novos.length} novos, ${sumidos.length} sumiram`);

    // Primeira execução não avisa: seria a lista inteira como "novidade".
    if (notificar && anteriores.length > 0 && novos.length > 0) {
      await avisarPorEmail(alerta, novos);
    }
  } catch (error) {
    console.error(`Alerta ${alerta.id} falhou:`, error.message);
    await pool.query('UPDATE alertas SET ultima_execucao = NOW(), erro = ? WHERE id = ?', [
      String(error.message).slice(0, 300),
      alerta.id,
    ]);
  }

  const [rows] = await pool.query('SELECT * FROM alertas WHERE id = ?', [alerta.id]);
  return rows[0];
}

// Verifica de tempos em tempos quem está na hora de rodar. Um por dia, por alerta.
async function processarAlertas() {
  try {
    const [rows] = await pool.query(
      `SELECT * FROM alertas
       WHERE ativo = TRUE
         AND hora <= HOUR(NOW())
         AND (ultima_execucao IS NULL OR DATE(ultima_execucao) < CURDATE())
       ORDER BY id
       LIMIT 10`
    );
    if (rows.length === 0) return;

    console.log(`Processando ${rows.length} alerta(s) agendado(s)`);
    for (const alerta of rows) {
      const conta = await contaDoUsuario(alerta.usuario_id);
      if (!conta || conta.vencida) {
        await pool.query('UPDATE alertas SET ultima_execucao = NOW(), erro = ? WHERE id = ?', [
          'Assinatura vencida',
          alerta.id,
        ]);
        continue;
      }

      const temCota = await consumirCota(conta.id, 'buscas', conta.limites.buscas_mes);
      if (!temCota) {
        // Marca como executado para não ficar tentando o dia inteiro.
        await pool.query('UPDATE alertas SET ultima_execucao = NOW(), erro = ? WHERE id = ?', [
          'Cota mensal de buscas esgotada',
          alerta.id,
        ]);
        continue;
      }
      await rodarAlerta(alerta, true);
    }
  } catch (error) {
    console.error('Falha ao processar alertas:', error.message);
  }
}

const PORT = process.env.PORT || 5000;
app.listen(PORT, async () => {
  console.log(`🚀 Servidor rodando na porta ${PORT}`);
  await prepararBanco();

  // A cada 15 minutos olha se algum alerta ativo está na hora.
  setInterval(processarAlertas, 15 * 60 * 1000);
  setTimeout(processarAlertas, 60 * 1000);
});
