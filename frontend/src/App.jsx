import React, { useState, useEffect, useCallback } from 'react';
import axios from 'axios';
import './App.css';
import './complementos.css';

const API_BASE = process.env.REACT_APP_API_URL || 'https://app-imobiliario-production.up.railway.app/api';

const CHAVE_SESSAO = 'radar_sessao';
const CHAVE_PERFIL = 'radar_perfil_corretor';
const CHAVE_BUSCA = 'radar_ultima_busca';

// ============ ARMAZENAMENTO LOCAL ============

const lerLocal = (chave, padrao) => {
  try {
    const bruto = localStorage.getItem(chave);
    return bruto ? { ...padrao, ...JSON.parse(bruto) } : padrao;
  } catch {
    return padrao;
  }
};

const gravarLocal = (chave, valor) => {
  try {
    localStorage.setItem(chave, JSON.stringify(valor));
  } catch {
    // navegador em modo privado ou storage cheio: seguir sem persistir
  }
};

// ============ API ============

const api = axios.create({ baseURL: API_BASE });

api.interceptors.request.use((config) => {
  try {
    const bruto = localStorage.getItem(CHAVE_SESSAO);
    const token = bruto ? JSON.parse(bruto).token : null;
    if (token) config.headers.Authorization = `Bearer ${token}`;
  } catch {
    // sem token: a requisição segue e o backend responde 401
  }
  return config;
});

const mensagemDeErro = (error, padrao) => error?.response?.data?.erro || padrao;

// ============ AUXILIARES ============

const formatarPreco = (valor) => {
  if (valor === null || valor === undefined || valor === '') return 'Preço não informado';
  return Number(valor).toLocaleString('pt-BR', {
    style: 'currency',
    currency: 'BRL',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  });
};

const montarLinkWhatsApp = (telefone, titulo) => {
  if (!telefone) return null;
  let numero = String(telefone).replace(/\D/g, '');
  if (numero.length < 10) return null;
  if (!numero.startsWith('55')) numero = '55' + numero;
  const msg = `Olá, vi o anúncio do imóvel "${titulo}". Ainda está disponível? Vocês trabalham com parceria entre corretores?`;
  return `https://wa.me/${numero}?text=${encodeURIComponent(msg)}`;
};

// Identidade estável do anúncio. Índice de array troca de dono quando a lista muda.
const idDoAnuncio = (anuncio, i) => anuncio.link || `${anuncio.site_origem || 's'}-${anuncio.titulo || i}`;

const quandoFoi = (data) => {
  if (!data) return '';
  const minutos = Math.round((Date.now() - new Date(data).getTime()) / 60000);
  if (minutos < 2) return 'agora';
  if (minutos < 60) return `há ${minutos} min`;
  const horas = Math.round(minutos / 60);
  return `há ${horas}h`;
};

const FORM_BUSCA_INICIAL = {
  cidade: '', bairro: '', tipo: '', preco_min: '', preco_max: '',
  quartos_min: '', banheiros_min: '', vagas_min: '', area_min: '', area_max: '', detalhes: '',
};

const FORM_PERFIL_INICIAL = {
  nome: '',
  email: '',
  telefone: '',
  mensagem: 'Olá, sou corretor e vi o anúncio deste imóvel. Ele ainda está disponível? Vocês trabalham com parceria entre corretores?',
};

const FORM_CARTEIRA_INICIAL = {
  titulo: '', preco: '', bairro: '', tipo: 'apartamento', quartos: '', banheiros: '',
  area_m2: '', descricao: '', contato_telefone: '', contato_email: '',
};

// ============ COMPONENTES ============
// Ficam fora do App de propósito: declarados dentro, o React os trata como
// componentes novos a cada render e remonta a subárvore inteira.

function BlocoAnalise({ dados }) {
  return (
    <div className="analise">
      <div className="analise-topo">
        <span className={`tag tag-${String(dados.parecer || '').toLowerCase()}`}>{dados.parecer}</span>
        <span className="analise-score">{dados.score}/100</span>
      </div>
      <div className="barra">
        <div className="barra-fill" style={{ width: `${dados.score || 0}%` }} />
      </div>
      <p className="analise-resumo">{dados.resumo}</p>
      <div className="analise-linhas">
        {dados.preco_sugestao ? (
          <span>Sugerido: <strong>{formatarPreco(dados.preco_sugestao)}</strong></span>
        ) : null}
        {dados.tempo_venda ? <span>Giro estimado: <strong>{dados.tempo_venda}</strong></span> : null}
      </div>
    </div>
  );
}

function BlocoContato({ anuncio, perfil, copiado, aoCopiar }) {
  const mensagem = `${perfil.mensagem || FORM_PERFIL_INICIAL.mensagem}\n\nImóvel: ${anuncio.titulo}`;
  const campos = [
    { rotulo: 'Nome', valor: perfil.nome },
    { rotulo: 'Email', valor: perfil.email },
    { rotulo: 'Telefone', valor: perfil.telefone },
    { rotulo: 'Mensagem', valor: mensagem, longo: true },
  ].filter((c) => c.valor);

  const tudo = [perfil.nome, perfil.email, perfil.telefone, mensagem].filter(Boolean).join('\n');

  return (
    <div className="contato-assistido">
      <p className="contato-titulo">Cole no formulário do portal</p>
      {campos.map((campo) => (
        <div className={`linha-copia ${campo.longo ? 'linha-longa' : ''}`} key={campo.rotulo}>
          <div className="linha-info">
            <span className="linha-rotulo">{campo.rotulo}</span>
            <span className="linha-valor">{campo.valor}</span>
          </div>
          <button className="btn btn-copiar" onClick={() => aoCopiar(campo.valor, campo.rotulo)}>
            {copiado === campo.rotulo ? 'Copiado' : 'Copiar'}
          </button>
        </div>
      ))}
      <div className="linha-copia">
        <div className="linha-info">
          <span className="linha-rotulo">Tudo junto</span>
          <span className="linha-valor">Nome, email, telefone e mensagem</span>
        </div>
        <button className="btn btn-copiar" onClick={() => aoCopiar(tudo, 'tudo')}>
          {copiado === 'tudo' ? 'Copiado' : 'Copiar'}
        </button>
      </div>
    </div>
  );
}

function Login({ aoEntrar }) {
  const [modo, setModo] = useState('login');
  const [dados, setDados] = useState({ nome_imobiliaria: '', email: '', senha: '', codigo: '' });
  const [enviando, setEnviando] = useState(false);
  const [erro, setErro] = useState('');

  const enviar = async (e) => {
    e.preventDefault();
    setEnviando(true);
    setErro('');
    try {
      const rota = modo === 'login' ? '/auth/login' : '/auth/registrar';
      const corpo = modo === 'login'
        ? { email: dados.email, senha: dados.senha }
        : dados;
      const res = await api.post(rota, corpo);
      aoEntrar(res.data);
    } catch (error) {
      setErro(mensagemDeErro(error, 'Não foi possível entrar agora.'));
    } finally {
      setEnviando(false);
    }
  };

  return (
    <div className="tela-login">
      <div className="caixa-login">
        <div className="marca marca-login">
          <span className="marca-icone">🏙️</span>
          <div>
            <h1>Radar Imobiliário</h1>
            <p>Imóveis de vários portais num lugar só</p>
          </div>
        </div>

        {erro ? <div className="alerta alerta-erro">{erro}</div> : null}

        <form onSubmit={enviar}>
          {modo === 'registrar' ? (
            <label className="campo-largo">
              <span>Nome da imobiliária</span>
              <input
                type="text"
                value={dados.nome_imobiliaria}
                onChange={(e) => setDados({ ...dados, nome_imobiliaria: e.target.value })}
                required
              />
            </label>
          ) : null}

          <label className="campo-largo">
            <span>Email</span>
            <input
              type="email"
              autoComplete="username"
              value={dados.email}
              onChange={(e) => setDados({ ...dados, email: e.target.value })}
              required
            />
          </label>

          <label className="campo-largo">
            <span>Senha</span>
            <input
              type="password"
              autoComplete={modo === 'login' ? 'current-password' : 'new-password'}
              value={dados.senha}
              onChange={(e) => setDados({ ...dados, senha: e.target.value })}
              required
            />
          </label>

          {modo === 'registrar' ? (
            <label className="campo-largo">
              <span>Código de convite</span>
              <input
                type="text"
                value={dados.codigo}
                onChange={(e) => setDados({ ...dados, codigo: e.target.value })}
                required
              />
            </label>
          ) : null}

          <button type="submit" className="btn btn-principal btn-bloco" disabled={enviando}>
            {enviando ? 'Aguarde...' : modo === 'login' ? 'Entrar' : 'Criar conta'}
          </button>
        </form>

        <button
          className="btn btn-texto btn-bloco"
          onClick={() => { setModo(modo === 'login' ? 'registrar' : 'login'); setErro(''); }}
        >
          {modo === 'login' ? 'Tenho um código de convite' : 'Já tenho conta'}
        </button>
      </div>
    </div>
  );
}

const STATUS_ROTULOS = {
  contatado: 'Contatado',
  respondeu: 'Respondeu',
  aceita_parceria: 'Aceita parceria',
  recusou: 'Não faz parceria',
  sem_resposta: 'Sem resposta',
};

function ControleStatus({ salvo, aoMarcarStatus }) {
  const atual = salvo?.status || '';
  return (
    <div className="status-linha">
      <span className="status-rotulo">Situação</span>
      <select
        className="status-select"
        value={atual}
        onChange={(e) => aoMarcarStatus(e.target.value || null)}
      >
        <option value="">Não contatado</option>
        {Object.entries(STATUS_ROTULOS).map(([valor, rotulo]) => (
          <option key={valor} value={valor}>{rotulo}</option>
        ))}
      </select>
    </div>
  );
}

function CartaoResultado({ anuncio, analise, analisando, perfil, perfilPreenchido, contatoAberto, copiado, salvo, aoAnalisar, aoAbrirContato, aoCopiar, aoFavoritar, aoMarcarStatus, aoContatar }) {
  const zap = montarLinkWhatsApp(anuncio.telefone, anuncio.titulo);
  const favorito = Boolean(salvo?.favorito);

  return (
    <article className={`card ${salvo?.status ? `card-${salvo.status}` : ''}`}>
      <div className="card-cabecalho">
        <div>
          <h3>{anuncio.titulo}</h3>
          <p className="local">
            {anuncio.bairro}
            {anuncio.cidade ? `, ${anuncio.cidade}` : ''}
            {anuncio.tipo ? ` · ${anuncio.tipo}` : ''}
          </p>
        </div>
        <div className="card-canto">
          <button
            className={`estrela ${favorito ? 'estrela-ativa' : ''}`}
            onClick={aoFavoritar}
            title={favorito ? 'Tirar dos favoritos' : 'Favoritar'}
            aria-label={favorito ? 'Tirar dos favoritos' : 'Favoritar'}
          >
            {favorito ? '★' : '☆'}
          </button>
          <span className="portal">{anuncio.site_origem}</span>
        </div>
      </div>

      <p className="preco">{formatarPreco(anuncio.preco)}</p>

      <ul className="specs">
        {anuncio.quartos ? <li>{anuncio.quartos} quartos</li> : null}
        {anuncio.banheiros ? <li>{anuncio.banheiros} banheiros</li> : null}
        {anuncio.vagas ? <li>{anuncio.vagas} vagas</li> : null}
        {anuncio.area_m2 ? <li>{anuncio.area_m2} m²</li> : null}
      </ul>

      {anuncio.aceita_parceria === true ? (
        <span className="parceria parceria-sim">Anúncio menciona parceria</span>
      ) : anuncio.aceita_parceria === false ? (
        <span className="parceria parceria-nao">Anúncio informa que não faz parceria</span>
      ) : (
        <span className="parceria parceria-null">Parceria não informada, confirme no contato</span>
      )}

      {analise ? <BlocoAnalise dados={analise} /> : null}

      {contatoAberto ? (
        <BlocoContato anuncio={anuncio} perfil={perfil} copiado={copiado} aoCopiar={aoCopiar} />
      ) : null}

      {salvo?.status || salvo?.favorito ? (
        <ControleStatus salvo={salvo} aoMarcarStatus={aoMarcarStatus} />
      ) : null}

      <div className="card-acoes">
        {zap ? (
          <a className="btn btn-zap" href={zap} target="_blank" rel="noreferrer" onClick={aoContatar}>
            Falar no WhatsApp
          </a>
        ) : null}

        {!zap && anuncio.link ? (
          <button className="btn btn-principal" onClick={aoAbrirContato}>
            {contatoAberto ? 'Contato aberto' : 'Contatar pelo portal'}
          </button>
        ) : null}

        {anuncio.link ? (
          <a className="btn btn-secundario" href={anuncio.link} target="_blank" rel="noreferrer">Ver anúncio</a>
        ) : null}

        <button className="btn btn-texto" onClick={aoAnalisar} disabled={analisando}>
          {analisando ? 'Analisando...' : analise ? 'Analisar de novo' : 'Analisar preço com IA'}
        </button>
      </div>
    </article>
  );
}

// ============ APP ============

function App() {
  const [sessao, setSessao] = useState(() => lerLocal(CHAVE_SESSAO, null));
  const [uso, setUso] = useState(null);
  const [aba, setAba] = useState('buscar');
  const [mensagem, setMensagem] = useState(null);

  const [formBusca, setFormBusca] = useState(() => lerLocal(CHAVE_BUSCA, FORM_BUSCA_INICIAL));
  const [buscando, setBuscando] = useState(false);
  const [resultados, setResultados] = useState(null);
  const [infoCache, setInfoCache] = useState(null);
  const [analises, setAnalises] = useState({});
  const [analisando, setAnalisando] = useState({});

  const [perfil, setPerfil] = useState(() => lerLocal(CHAVE_PERFIL, FORM_PERFIL_INICIAL));
  const [contatoAberto, setContatoAberto] = useState(null);
  const [copiado, setCopiado] = useState(null);

  const [carteira, setCarteira] = useState([]);
  const [formCarteira, setFormCarteira] = useState(FORM_CARTEIRA_INICIAL);
  const [salvando, setSalvando] = useState(false);
  const [mostrarFormCarteira, setMostrarFormCarteira] = useState(false);

  // Anúncios marcados, indexados pelo mesmo id local que os cards usam.
  const [salvos, setSalvos] = useState({});
  const [historico, setHistorico] = useState([]);
  const [filtroSalvos, setFiltroSalvos] = useState('todos');

  const aviso = (texto, tipo = 'info') => {
    setMensagem({ texto, tipo });
    if (tipo !== 'erro') setTimeout(() => setMensagem(null), 5000);
  };

  const sair = useCallback(() => {
    try { localStorage.removeItem(CHAVE_SESSAO); } catch { /* segue */ }
    setSessao(null);
    setResultados(null);
    setCarteira([]);
    setUso(null);
  }, []);

  const entrar = (dados) => {
    gravarLocal(CHAVE_SESSAO, dados);
    setSessao(dados);
  };

  const tratarErro = useCallback((error, padrao) => {
    if (error?.response?.status === 401) {
      sair();
      return;
    }
    aviso(mensagemDeErro(error, padrao), 'erro');
  }, [sair]);

  const carregarUso = useCallback(async () => {
    try {
      const res = await api.get('/auth/eu');
      setUso(res.data.uso_hoje);
    } catch (error) {
      if (error?.response?.status === 401) sair();
    }
  }, [sair]);

  useEffect(() => {
    if (sessao) carregarUso();
  }, [sessao, carregarUso]);

  const executarBusca = async (forcar, formAlvo) => {
    const alvo = formAlvo || formBusca;
    if (!alvo.bairro || !String(alvo.bairro).trim()) {
      aviso('Informe pelo menos o bairro para buscar', 'erro');
      return;
    }
    setBuscando(true);
    setResultados(null);
    setInfoCache(null);
    setAnalises({});
    setContatoAberto(null);
    gravarLocal(CHAVE_BUSCA, alvo);
    try {
      const payload = Object.fromEntries(
        Object.entries(alvo).filter(([, v]) => String(v).trim() !== '')
      );
      if (forcar) payload.forcar = '1';
      const res = await api.post('/buscar-anuncios', payload);
      setResultados(res.data.anuncios || []);
      setInfoCache({ do_cache: res.data.do_cache, buscado_em: res.data.buscado_em });
      carregarUso();
      carregarHistorico();
    } catch (error) {
      tratarErro(error, 'Não foi possível concluir a busca agora');
      setResultados([]);
    } finally {
      setBuscando(false);
    }
  };

  const analisarAnuncio = async (anuncio, id) => {
    setAnalisando((a) => ({ ...a, [id]: true }));
    try {
      const res = await api.post('/analisar-avulso', {
        titulo: anuncio.titulo,
        preco: anuncio.preco,
        bairro: anuncio.bairro,
        tipo: anuncio.tipo,
        quartos: anuncio.quartos,
        banheiros: anuncio.banheiros,
        area_m2: anuncio.area_m2,
        descricao: `${anuncio.tipo || ''} em ${anuncio.bairro || ''}${anuncio.cidade ? ', ' + anuncio.cidade : ''}`,
      });
      setAnalises((a) => ({ ...a, [id]: res.data }));
      carregarUso();
    } catch (error) {
      tratarErro(error, 'Não foi possível analisar este imóvel');
    } finally {
      setAnalisando((a) => ({ ...a, [id]: false }));
    }
  };

  const carregarSalvos = useCallback(async () => {
    try {
      const res = await api.get('/salvos');
      const mapa = {};
      (res.data || []).forEach((registro) => {
        mapa[idDoAnuncio(registro, registro.id)] = registro;
      });
      setSalvos(mapa);
    } catch (error) {
      tratarErro(error, 'Não foi possível carregar os salvos');
    }
  }, [tratarErro]);

  const carregarHistorico = useCallback(async () => {
    try {
      const res = await api.get('/historico');
      setHistorico(res.data || []);
    } catch (error) {
      if (error?.response?.status === 401) sair();
    }
  }, [sair]);

  // mudancas: { favorito } e/ou { status } e/ou { observacao }
  const marcarAnuncio = async (anuncio, id, mudancas) => {
    try {
      const res = await api.post('/salvos', { anuncio, ...mudancas });
      setSalvos((s) => ({ ...s, [id]: res.data }));
    } catch (error) {
      tratarErro(error, 'Não foi possível salvar a marcação');
    }
  };

  const removerSalvo = async (chave, id) => {
    try {
      await api.delete(`/salvos/${chave}`);
      setSalvos((s) => {
        const copia = { ...s };
        delete copia[id];
        return copia;
      });
    } catch (error) {
      tratarErro(error, 'Não foi possível remover');
    }
  };

  const carregarCarteira = useCallback(async () => {
    try {
      const res = await api.get('/imoveis');
      setCarteira(res.data || []);
    } catch (error) {
      tratarErro(error, 'Não foi possível carregar sua carteira');
    }
  }, [tratarErro]);

  useEffect(() => {
    if (sessao && aba === 'carteira') carregarCarteira();
  }, [sessao, aba, carregarCarteira]);

  useEffect(() => {
    if (!sessao) return;
    carregarSalvos();
    carregarHistorico();
  }, [sessao, carregarSalvos, carregarHistorico]);

  const salvarNaCarteira = async (e) => {
    e.preventDefault();
    setSalvando(true);
    try {
      await api.post('/imoveis', formCarteira);
      setFormCarteira(FORM_CARTEIRA_INICIAL);
      setMostrarFormCarteira(false);
      aviso('Imóvel adicionado à carteira', 'sucesso');
      await carregarCarteira();
    } catch (error) {
      tratarErro(error, 'Não foi possível salvar');
    } finally {
      setSalvando(false);
    }
  };

  const removerDaCarteira = async (id) => {
    if (!window.confirm('Remover este imóvel da carteira?')) return;
    try {
      await api.delete(`/imoveis/${id}`);
      aviso('Imóvel removido', 'sucesso');
      await carregarCarteira();
    } catch (error) {
      tratarErro(error, 'Não foi possível remover');
    }
  };

  const analisarDaCarteira = async (id) => {
    const chave = `c${id}`;
    setAnalisando((a) => ({ ...a, [chave]: true }));
    try {
      const res = await api.post(`/imoveis/${id}/analisar`);
      setAnalises((a) => ({ ...a, [chave]: res.data }));
      carregarUso();
    } catch (error) {
      tratarErro(error, 'Não foi possível analisar');
    } finally {
      setAnalisando((a) => ({ ...a, [chave]: false }));
    }
  };

  const salvarPerfil = (e) => {
    e.preventDefault();
    gravarLocal(CHAVE_PERFIL, perfil);
    aviso('Perfil salvo neste navegador', 'sucesso');
  };

  const perfilPreenchido = Boolean(perfil.nome && perfil.telefone);

  const copiar = async (texto, rotulo, marcador) => {
    try {
      await navigator.clipboard.writeText(texto);
      setCopiado(`${marcador}-${rotulo}`);
      setTimeout(() => setCopiado((m) => (m === `${marcador}-${rotulo}` ? null : m)), 2000);
    } catch {
      aviso('Seu navegador bloqueou a cópia automática', 'erro');
    }
  };

  const abrirContato = (anuncio, id) => {
    if (!perfilPreenchido) {
      aviso('Preencha seu perfil primeiro para agilizar o contato', 'erro');
      setAba('perfil');
      return;
    }
    setContatoAberto((atual) => (atual === id ? null : id));
    marcarAnuncio(anuncio, id, { status: 'contatado' });
    window.open(anuncio.link, '_blank', 'noopener');
  };

  // Reaproveita uma busca antiga: preenche o formulário e dispara de novo.
  const repetirBusca = (criterios) => {
    const alvo = { ...FORM_BUSCA_INICIAL, ...criterios };
    setFormBusca(alvo);
    setAba('buscar');
    executarBusca(false, alvo);
  };

  if (!sessao) return <Login aoEntrar={entrar} />;

  return (
    <div className="app">
      <header className="topo">
        <div className="topo-inner">
          <div className="marca">
            <span className="marca-icone">🏙️</span>
            <div>
              <h1>Radar Imobiliário</h1>
              <p>{sessao.usuario?.nome_imobiliaria}</p>
            </div>
            <div className="topo-direita">
              {uso ? <span className="cota">{uso.buscas_restantes} buscas hoje</span> : null}
              <button className="btn btn-texto" onClick={sair}>Sair</button>
            </div>
          </div>
          <nav className="abas">
            <button className={aba === 'buscar' ? 'ativa' : ''} onClick={() => setAba('buscar')}>Buscar imóveis</button>
            <button className={aba === 'salvos' ? 'ativa' : ''} onClick={() => setAba('salvos')}>
              Salvos{Object.keys(salvos).length ? ` (${Object.keys(salvos).length})` : ''}
            </button>
            <button className={aba === 'carteira' ? 'ativa' : ''} onClick={() => setAba('carteira')}>Minha carteira</button>
            <button className={aba === 'perfil' ? 'ativa' : ''} onClick={() => setAba('perfil')}>Meu perfil</button>
          </nav>
        </div>
      </header>

      {mensagem ? <div className={`alerta alerta-${mensagem.tipo}`}>{mensagem.texto}</div> : null}

      <main className="conteudo">
        {aba === 'buscar' ? (
          <>
            <section className="painel">
              <h2>O que você está procurando?</h2>
              <p className="ajuda">Só o bairro é obrigatório. Quanto mais campos preencher, mais precisa fica a busca.</p>

              <form onSubmit={(e) => { e.preventDefault(); executarBusca(false); }}>
                <div className="grid grid-2">
                  <label>
                    <span>Bairro <em>obrigatório</em></span>
                    <input type="text" placeholder="Ex: Águas Claras" value={formBusca.bairro}
                      onChange={(e) => setFormBusca({ ...formBusca, bairro: e.target.value })} />
                  </label>
                  <label>
                    <span>Cidade</span>
                    <input type="text" placeholder="Ex: Brasília" value={formBusca.cidade}
                      onChange={(e) => setFormBusca({ ...formBusca, cidade: e.target.value })} />
                  </label>
                </div>

                <div className="grid grid-3">
                  <label>
                    <span>Tipo</span>
                    <select value={formBusca.tipo} onChange={(e) => setFormBusca({ ...formBusca, tipo: e.target.value })}>
                      <option value="">Qualquer</option>
                      <option value="apartamento">Apartamento</option>
                      <option value="casa">Casa</option>
                      <option value="terreno">Terreno</option>
                      <option value="comercial">Comercial</option>
                      <option value="sala comercial">Sala comercial</option>
                    </select>
                  </label>
                  <label>
                    <span>Preço mínimo</span>
                    <input type="number" placeholder="R$" value={formBusca.preco_min}
                      onChange={(e) => setFormBusca({ ...formBusca, preco_min: e.target.value })} />
                  </label>
                  <label>
                    <span>Preço máximo</span>
                    <input type="number" placeholder="R$" value={formBusca.preco_max}
                      onChange={(e) => setFormBusca({ ...formBusca, preco_max: e.target.value })} />
                  </label>
                </div>

                <div className="grid grid-3">
                  <label>
                    <span>Quartos (mínimo)</span>
                    <input type="number" min="0" value={formBusca.quartos_min}
                      onChange={(e) => setFormBusca({ ...formBusca, quartos_min: e.target.value })} />
                  </label>
                  <label>
                    <span>Banheiros (mínimo)</span>
                    <input type="number" min="0" value={formBusca.banheiros_min}
                      onChange={(e) => setFormBusca({ ...formBusca, banheiros_min: e.target.value })} />
                  </label>
                  <label>
                    <span>Vagas (mínimo)</span>
                    <input type="number" min="0" value={formBusca.vagas_min}
                      onChange={(e) => setFormBusca({ ...formBusca, vagas_min: e.target.value })} />
                  </label>
                </div>

                <div className="grid grid-2">
                  <label>
                    <span>Área mínima (m²)</span>
                    <input type="number" min="0" value={formBusca.area_min}
                      onChange={(e) => setFormBusca({ ...formBusca, area_min: e.target.value })} />
                  </label>
                  <label>
                    <span>Área máxima (m²)</span>
                    <input type="number" min="0" value={formBusca.area_max}
                      onChange={(e) => setFormBusca({ ...formBusca, area_max: e.target.value })} />
                  </label>
                </div>

                <label className="campo-largo">
                  <span>Detalhes extras</span>
                  <textarea rows="3" placeholder="Ex: com piscina, perto do metrô, aceita animais, mobiliado"
                    value={formBusca.detalhes}
                    onChange={(e) => setFormBusca({ ...formBusca, detalhes: e.target.value })} />
                </label>

                <div className="acoes-form">
                  <button type="submit" className="btn btn-principal" disabled={buscando}>
                    {buscando ? 'Buscando nos portais...' : 'Buscar imóveis'}
                  </button>
                  <button type="button" className="btn btn-texto" disabled={buscando}
                    onClick={() => { setFormBusca(FORM_BUSCA_INICIAL); setResultados(null); setInfoCache(null); }}>
                    Limpar campos
                  </button>
                </div>
              </form>
            </section>

            {historico.length > 0 && !buscando ? (
              <section className="painel">
                <h2>Buscas recentes</h2>
                <p className="ajuda">Clique para repetir. Busca repetida nas últimas horas sai do cache, sem custo.</p>
                <div className="historico">
                  {historico.map((h) => (
                    <button key={h.id} className="chip" onClick={() => repetirBusca(h.criterios)}>
                      <span className="chip-texto">
                        {h.criterios.bairro}
                        {h.criterios.cidade ? `, ${h.criterios.cidade}` : ''}
                        {h.criterios.tipo ? ` · ${h.criterios.tipo}` : ''}
                      </span>
                      <span className="chip-meta">{h.resultados} · {quandoFoi(h.criado_em)}</span>
                    </button>
                  ))}
                </div>
              </section>
            ) : null}

            {buscando ? (
              <section className="painel estado">
                <div className="spinner" />
                <p>Consultando os portais de imóveis. Isso leva alguns segundos.</p>
              </section>
            ) : null}

            {!buscando && resultados !== null ? (
              <section className="resultados">
                <div className="resultados-topo">
                  <h2>{resultados.length} {resultados.length === 1 ? 'imóvel encontrado' : 'imóveis encontrados'}</h2>
                  <div className="frescor">
                    {infoCache?.do_cache ? (
                      <>
                        <span className="capturado">Resultado salvo {quandoFoi(infoCache.buscado_em)}</span>
                        <button className="btn btn-texto" onClick={() => executarBusca(true)}>Buscar de novo</button>
                      </>
                    ) : (
                      <span className="capturado">Capturado agora, confirme disponibilidade com o anunciante</span>
                    )}
                  </div>
                </div>

                {resultados.length === 0 ? (
                  <div className="painel estado">
                    <p>Nenhum anúncio encontrado com esses critérios. Tente ampliar a faixa de preço ou remover alguns filtros.</p>
                  </div>
                ) : (
                  <div className="lista">
                    {resultados.map((anuncio, i) => {
                      const id = idDoAnuncio(anuncio, i);
                      return (
                        <CartaoResultado
                          key={id}
                          anuncio={anuncio}
                          analise={analises[id]}
                          analisando={Boolean(analisando[id])}
                          perfil={perfil}
                          perfilPreenchido={perfilPreenchido}
                          contatoAberto={contatoAberto === id}
                          copiado={copiado && copiado.startsWith(`${id}-`) ? copiado.slice(id.length + 1) : null}
                          salvo={salvos[id]}
                          aoAnalisar={() => analisarAnuncio(anuncio, id)}
                          aoAbrirContato={() => abrirContato(anuncio, id)}
                          aoCopiar={(texto, rotulo) => copiar(texto, rotulo, id)}
                          aoFavoritar={() => marcarAnuncio(anuncio, id, { favorito: !salvos[id]?.favorito })}
                          aoMarcarStatus={(status) => marcarAnuncio(anuncio, id, { status })}
                          aoContatar={() => marcarAnuncio(anuncio, id, { status: 'contatado' })}
                        />
                      );
                    })}
                  </div>
                )}
              </section>
            ) : null}
          </>
        ) : aba === 'salvos' ? (
          <>
            <section className="painel">
              <h2>Anúncios salvos</h2>
              <p className="ajuda">O que você favoritou e o que já contatou. Fica guardado mesmo depois que o anúncio sai do ar.</p>
              <div className="filtros-chips">
                {[
                  ['todos', 'Todos'],
                  ['favoritos', 'Favoritos'],
                  ['aceita_parceria', 'Aceita parceria'],
                  ['contatado', 'Contatados'],
                  ['sem_resposta', 'Sem resposta'],
                ].map(([valor, rotulo]) => (
                  <button
                    key={valor}
                    className={`chip chip-filtro ${filtroSalvos === valor ? 'chip-ativo' : ''}`}
                    onClick={() => setFiltroSalvos(valor)}
                  >
                    {rotulo}
                  </button>
                ))}
              </div>
            </section>

            <section className="resultados">
              {(() => {
                const lista = Object.entries(salvos).filter(([, r]) => {
                  if (filtroSalvos === 'todos') return true;
                  if (filtroSalvos === 'favoritos') return Boolean(r.favorito);
                  return r.status === filtroSalvos;
                });

                if (lista.length === 0) {
                  return (
                    <div className="painel estado">
                      <p>Nada aqui ainda. Favorite um anúncio na busca ou marque a situação depois de contatar.</p>
                    </div>
                  );
                }

                return (
                  <div className="lista">
                    {lista.map(([id, registro]) => {
                      const anuncio = registro.dados || registro;
                      return (
                        <article className={`card ${registro.status ? `card-${registro.status}` : ''}`} key={registro.chave}>
                          <div className="card-cabecalho">
                            <div>
                              <h3>{registro.titulo}</h3>
                              <p className="local">
                                {registro.bairro}
                                {registro.cidade ? `, ${registro.cidade}` : ''}
                              </p>
                            </div>
                            <div className="card-canto">
                              <button
                                className={`estrela ${registro.favorito ? 'estrela-ativa' : ''}`}
                                onClick={() => marcarAnuncio(anuncio, id, { favorito: !registro.favorito })}
                                aria-label="Favoritar"
                              >
                                {registro.favorito ? '★' : '☆'}
                              </button>
                              <span className="portal">{registro.site_origem}</span>
                            </div>
                          </div>

                          <p className="preco">{formatarPreco(registro.preco)}</p>

                          <ControleStatus
                            salvo={registro}
                            aoMarcarStatus={(status) => marcarAnuncio(anuncio, id, { status })}
                          />

                          {registro.contatado_em ? (
                            <p className="marca-tempo">Contatado {quandoFoi(registro.contatado_em)}</p>
                          ) : null}

                          <div className="card-acoes">
                            {montarLinkWhatsApp(anuncio.telefone, registro.titulo) ? (
                              <a className="btn btn-zap" target="_blank" rel="noreferrer"
                                href={montarLinkWhatsApp(anuncio.telefone, registro.titulo)}>
                                Falar no WhatsApp
                              </a>
                            ) : null}
                            {registro.link ? (
                              <a className="btn btn-secundario" href={registro.link} target="_blank" rel="noreferrer">
                                Ver anúncio
                              </a>
                            ) : null}
                            <button className="btn btn-texto btn-perigo" onClick={() => removerSalvo(registro.chave, id)}>
                              Remover
                            </button>
                          </div>
                        </article>
                      );
                    })}
                  </div>
                );
              })()}
            </section>
          </>
        ) : aba === 'perfil' ? (
          <section className="painel">
            <h2>Meu perfil</h2>
            <p className="ajuda">
              Esses dados ficam salvos só neste navegador e são usados para agilizar o preenchimento
              dos formulários de contato dos portais.
            </p>

            <form onSubmit={salvarPerfil}>
              <div className="grid grid-2">
                <label>
                  <span>Nome <em>obrigatório</em></span>
                  <input type="text" placeholder="Como aparece para o anunciante" value={perfil.nome}
                    onChange={(e) => setPerfil({ ...perfil, nome: e.target.value })} required />
                </label>
                <label>
                  <span>Telefone <em>obrigatório</em></span>
                  <input type="tel" placeholder="(61) 90000-0000" value={perfil.telefone}
                    onChange={(e) => setPerfil({ ...perfil, telefone: e.target.value })} required />
                </label>
              </div>

              <label className="campo-largo">
                <span>Email</span>
                <input type="email" placeholder="seu@email.com" value={perfil.email}
                  onChange={(e) => setPerfil({ ...perfil, email: e.target.value })} />
              </label>

              <label className="campo-largo">
                <span>Mensagem padrão</span>
                <textarea rows="4" value={perfil.mensagem}
                  onChange={(e) => setPerfil({ ...perfil, mensagem: e.target.value })} />
              </label>

              <button type="submit" className="btn btn-principal">Salvar perfil</button>
            </form>
          </section>
        ) : (
          <>
            <section className="painel">
              <div className="carteira-topo">
                <div>
                  <h2>Minha carteira</h2>
                  <p className="ajuda">Os imóveis que você representa. Em breve conectamos direto com a API da imobiliária.</p>
                </div>
                <button className="btn btn-principal" onClick={() => setMostrarFormCarteira((v) => !v)}>
                  {mostrarFormCarteira ? 'Cancelar' : 'Adicionar imóvel'}
                </button>
              </div>

              {mostrarFormCarteira ? (
                <form onSubmit={salvarNaCarteira} className="form-carteira">
                  <div className="grid grid-2">
                    <label>
                      <span>Título <em>obrigatório</em></span>
                      <input type="text" value={formCarteira.titulo}
                        onChange={(e) => setFormCarteira({ ...formCarteira, titulo: e.target.value })} required />
                    </label>
                    <label>
                      <span>Preço <em>obrigatório</em></span>
                      <input type="number" value={formCarteira.preco}
                        onChange={(e) => setFormCarteira({ ...formCarteira, preco: e.target.value })} required />
                    </label>
                  </div>

                  <div className="grid grid-2">
                    <label>
                      <span>Bairro <em>obrigatório</em></span>
                      <input type="text" value={formCarteira.bairro}
                        onChange={(e) => setFormCarteira({ ...formCarteira, bairro: e.target.value })} required />
                    </label>
                    <label>
                      <span>Tipo</span>
                      <select value={formCarteira.tipo}
                        onChange={(e) => setFormCarteira({ ...formCarteira, tipo: e.target.value })}>
                        <option value="apartamento">Apartamento</option>
                        <option value="casa">Casa</option>
                        <option value="terreno">Terreno</option>
                        <option value="comercial">Comercial</option>
                      </select>
                    </label>
                  </div>

                  <div className="grid grid-3">
                    <label>
                      <span>Quartos</span>
                      <input type="number" value={formCarteira.quartos}
                        onChange={(e) => setFormCarteira({ ...formCarteira, quartos: e.target.value })} />
                    </label>
                    <label>
                      <span>Banheiros</span>
                      <input type="number" value={formCarteira.banheiros}
                        onChange={(e) => setFormCarteira({ ...formCarteira, banheiros: e.target.value })} />
                    </label>
                    <label>
                      <span>Área (m²)</span>
                      <input type="number" value={formCarteira.area_m2}
                        onChange={(e) => setFormCarteira({ ...formCarteira, area_m2: e.target.value })} />
                    </label>
                  </div>

                  <label className="campo-largo">
                    <span>Descrição</span>
                    <textarea rows="3" value={formCarteira.descricao}
                      onChange={(e) => setFormCarteira({ ...formCarteira, descricao: e.target.value })} />
                  </label>

                  <div className="grid grid-2">
                    <label>
                      <span>Telefone de contato</span>
                      <input type="tel" value={formCarteira.contato_telefone}
                        onChange={(e) => setFormCarteira({ ...formCarteira, contato_telefone: e.target.value })} />
                    </label>
                    <label>
                      <span>Email de contato</span>
                      <input type="email" value={formCarteira.contato_email}
                        onChange={(e) => setFormCarteira({ ...formCarteira, contato_email: e.target.value })} />
                    </label>
                  </div>

                  <button type="submit" className="btn btn-principal" disabled={salvando}>
                    {salvando ? 'Salvando...' : 'Salvar na carteira'}
                  </button>
                </form>
              ) : null}
            </section>

            <section className="resultados">
              {carteira.length === 0 ? (
                <div className="painel estado">
                  <p>Sua carteira está vazia. Adicione os imóveis que você representa.</p>
                </div>
              ) : (
                <div className="lista">
                  {carteira.map((im) => (
                    <article className="card" key={im.id}>
                      <div className="card-cabecalho">
                        <div>
                          <h3>{im.titulo}</h3>
                          <p className="local">{im.bairro}{im.tipo ? ` · ${im.tipo}` : ''}</p>
                        </div>
                      </div>

                      <p className="preco">{formatarPreco(im.preco)}</p>

                      <ul className="specs">
                        {im.quartos ? <li>{im.quartos} quartos</li> : null}
                        {im.banheiros ? <li>{im.banheiros} banheiros</li> : null}
                        {im.area_m2 ? <li>{Number(im.area_m2)} m²</li> : null}
                      </ul>

                      {im.descricao ? <p className="descricao">{im.descricao}</p> : null}

                      {im.contato_telefone || im.contato_email ? (
                        <p className="contato">
                          {im.contato_telefone ? im.contato_telefone : ''}
                          {im.contato_telefone && im.contato_email ? ' · ' : ''}
                          {im.contato_email ? im.contato_email : ''}
                        </p>
                      ) : null}

                      {analises[`c${im.id}`] ? <BlocoAnalise dados={analises[`c${im.id}`]} /> : null}

                      <div className="card-acoes">
                        <button className="btn btn-secundario" onClick={() => analisarDaCarteira(im.id)}
                          disabled={analisando[`c${im.id}`]}>
                          {analisando[`c${im.id}`] ? 'Analisando...' : 'Analisar preço com IA'}
                        </button>
                        <button className="btn btn-texto btn-perigo" onClick={() => removerDaCarteira(im.id)}>
                          Remover
                        </button>
                      </div>
                    </article>
                  ))}
                </div>
              )}
            </section>
          </>
        )}
      </main>

      <footer className="rodape">
        <p>Radar Imobiliário · dados capturados de portais públicos, sempre confirme disponibilidade com o anunciante</p>
      </footer>
    </div>
  );
}

export default App;
