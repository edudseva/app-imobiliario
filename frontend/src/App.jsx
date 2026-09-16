import React, { useState, useEffect } from 'react';
import axios from 'axios';
import './App.css';

const API_BASE = process.env.REACT_APP_API_URL || 'http://localhost:5000/api';

function App() {
  const [imoveis, setImoveis] = useState([]);
  const [filtro, setFiltro] = useState({ bairro: '', tipo: '', preco_min: '', preco_max: '' });
  const [formulario, setFormulario] = useState({
    titulo: '', preco: '', bairro: '', tipo: 'apartamento',
    quartos: 2, banheiros: 1, area_m2: '', descricao: '',
    contato_telefone: '', contato_email: '',
  });
  const [imovelSelecionado, setImovelSelecionado] = useState(null);
  const [analise, setAnalise] = useState(null);
  const [carregando, setCarregando] = useState(false);
  const [mensagem, setMensagem] = useState('');
  const [aba, setAba] = useState('lista');

  const buscarImoveis = async () => {
    try {
      const params = Object.fromEntries(Object.entries(filtro).filter(([, v]) => v !== ''));
      const res = await axios.get(`${API_BASE}/imoveis`, { params });
      setImoveis(res.data || []);
    } catch (error) { setMensagem(`Erro ao buscar: ${error.message}`); }
  };

  const adicionarImovel = async (e) => {
    e.preventDefault();
    try {
      await axios.post(`${API_BASE}/imoveis`, formulario);
      setMensagem('✅ Imóvel adicionado com sucesso!');
      setFormulario({ titulo: '', preco: '', bairro: '', tipo: 'apartamento', quartos: 2, banheiros: 1, area_m2: '', descricao: '', contato_telefone: '', contato_email: '' });
      await buscarImoveis();
      setTimeout(() => setAba('lista'), 1500);
    } catch (error) { setMensagem(`❌ Erro: ${error.response?.data?.erro || error.message}`); }
  };

  const analisarComIA = async (id) => {
    setCarregando(true);
    try {
      const res = await axios.post(`${API_BASE}/imoveis/${id}/analisar`);
      setAnalise(res.data);
    } catch (error) { setMensagem(`❌ Erro na análise: ${error.message}`); }
    finally { setCarregando(false); }
  };

  const deletar = async (id) => {
    if (window.confirm('Tem certeza?')) {
      try {
        await axios.delete(`${API_BASE}/imoveis/${id}`);
        setMensagem('✅ Imóvel deletado');
        await buscarImoveis();
      } catch (error) { setMensagem(`❌ Erro ao deletar: ${error.message}`); }
    }
  };

  useEffect(() => { buscarImoveis(); }, []);

  return (
    <div className="App">
      <header className="header">
        <h1>🏠 Agregador Imobiliário</h1>
        <p>Com análise de IA</p>
      </header>

      {mensagem && <div className={`mensagem ${mensagem.includes('✅') ? 'sucesso' : 'erro'}`}>{mensagem}</div>}

      <nav className="abas">
        <button className={`aba ${aba === 'lista' ? 'ativa' : ''}`} onClick={() => setAba('lista')}>📋 Listar</button>
        <button className={`aba ${aba === 'adicionar' ? 'ativa' : ''}`} onClick={() => setAba('adicionar')}>➕ Adicionar</button>
        <button className={`aba ${aba === 'buscar' ? 'ativa' : ''}`} onClick={() => setAba('buscar')}>🔍 Filtrar</button>
      </nav>

      <div className="container">
        {aba === 'adicionar' && (
          <section className="secao">
            <h2>Adicionar Novo Imóvel</h2>
            <form onSubmit={adicionarImovel} className="formulario">
              <div className="form-row">
                <input type="text" placeholder="Título do anúncio" value={formulario.titulo} onChange={(e) => setFormulario({ ...formulario, titulo: e.target.value })} required />
                <input type="number" placeholder="Preço (R$)" value={formulario.preco} onChange={(e) => setFormulario({ ...formulario, preco: e.target.value })} required />
              </div>
              <div className="form-row">
                <input type="text" placeholder="Bairro" value={formulario.bairro} onChange={(e) => setFormulario({ ...formulario, bairro: e.target.value })} required />
                <select value={formulario.tipo} onChange={(e) => setFormulario({ ...formulario, tipo: e.target.value })}>
                  <option>apartamento</option><option>casa</option><option>terreno</option><option>comercial</option>
                </select>
              </div>
              <div className="form-row">
                <input type="number" placeholder="Quartos" value={formulario.quartos} onChange={(e) => setFormulario({ ...formulario, quartos: e.target.value })} />
                <input type="number" placeholder="Banheiros" value={formulario.banheiros} onChange={(e) => setFormulario({ ...formulario, banheiros: e.target.value })} />
                <input type="number" placeholder="Área (m²)" value={formulario.area_m2} onChange={(e) => setFormulario({ ...formulario, area_m2: e.target.value })} />
              </div>
              <textarea placeholder="Descrição" value={formulario.descricao} onChange={(e) => setFormulario({ ...formulario, descricao: e.target.value })}></textarea>
              <div className="form-row">
                <input type="tel" placeholder="Telefone" value={formulario.contato_telefone} onChange={(e) => setFormulario({ ...formulario, contato_telefone: e.target.value })} />
                <input type="email" placeholder="Email" value={formulario.contato_email} onChange={(e) => setFormulario({ ...formulario, contato_email: e.target.value })} />
              </div>
              <button type="submit" className="btn-submit">Adicionar Imóvel</button>
            </form>
          </section>
        )}

        {aba === 'buscar' && (
          <section className="secao">
            <h2>Filtrar Imóveis</h2>
            <div className="form-row">
              <input type="text" placeholder="Bairro" value={filtro.bairro} onChange={(e) => setFiltro({ ...filtro, bairro: e.target.value })} />
              <select value={filtro.tipo} onChange={(e) => setFiltro({ ...filtro, tipo: e.target.value })}>
                <option value="">Todos os tipos</option><option>apartamento</option><option>casa</option><option>terreno</option><option>comercial</option>
              </select>
              <input type="number" placeholder="Preço mín" value={filtro.preco_min} onChange={(e) => setFiltro({ ...filtro, preco_min: e.target.value })} />
              <input type="number" placeholder="Preço máx" value={filtro.preco_max} onChange={(e) => setFiltro({ ...filtro, preco_max: e.target.value })} />
            </div>
            <button onClick={buscarImoveis} className="btn-buscar">Buscar</button>
          </section>
        )}

        {aba === 'lista' && (
          <>
            <section className="secao">
              <h2>Imóveis ({imoveis.length})</h2>
              <div className="cards">
                {imoveis.length === 0 ? (
                  <p className="vazio">Nenhum imóvel. Adicione um!</p>
                ) : (
                  imoveis.map((im) => (
                    <div key={im.id} className="card">
                      <h3>{im.titulo}</h3>
                      <p className="preco">R$ {im.preco?.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}</p>
                      <p className="info"><strong>Local:</strong> {im.bairro} | {im.tipo}</p>
                      <p className="info"><strong>Quartos:</strong> {im.quartos} | <strong>Área:</strong> {im.area_m2}m²</p>
                      <p className="descricao">{im.descricao}</p>
                      <p className="contato">☎ {im.contato_telefone} | 📧 {im.contato_email}</p>
                      <div className="acoes">
                        <button onClick={() => { setImovelSelecionado(im); analisarComIA(im.id); }} disabled={carregando} className="btn-analisa">
                          {carregando ? '⏳ Analisando...' : '🤖 Analisar IA'}
                        </button>
                        <button onClick={() => deletar(im.id)} className="btn-deletar">🗑️ Deletar</button>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </section>

            {analise && (
              <section className="secao">
                <h2>📊 Análise IA - {imovelSelecionado?.titulo}</h2>
                <div className="resultado">
                  <div className="analise-grid">
                    <div className="item-analise"><label>Resumo</label><p>{analise.resumo}</p></div>
                    <div className="item-analise"><label>Score</label><p className="score">{analise.score}/100</p><div className="barra-score"><div className="barra-preenchida" style={{ width: `${analise.score}%` }}></div></div></div>
                    <div className="item-analise"><label>Parecer</label><p className="parecer">{analise.parecer}</p></div>
                    <div className="item-analise"><label>Tempo de Venda</label><p>{analise.tempo_venda}</p></div>
                    {analise.preco_sugestao && <div className="item-analise"><label>Preço Sugerido</label><p className="preco-sugestao">R$ {analise.preco_sugestao?.toLocaleString('pt-BR')}</p></div>}
                    <div className="item-analise"><label>Oportunidade?</label><p className={analise.oportunidade ? 'oportunidade-sim' : 'oportunidade-nao'}>{analise.oportunidade ? '✅ Sim' : '❌ Não'}</p></div>
                  </div>
                </div>
              </section>
            )}
          </>
        )}
      </div>
      <footer className="footer"><p>Agregador Imobiliário com IA • 2024</p></footer>
    </div>
  );
}

export default App;
