import React, { useState } from 'react'

function App(){
  const[messages,setMessages] = useState([
    {text: "Hi! Ask me anything about your DAA study guide,", isBot: true},
  ]);

  const [input,setInput] = useState("");
  const[loading,setLoading] = useState(false);

  const handleSend = async(e) => {
    e.preventDefault();
    const trimmedInput = input.trim();
    if(!trimmedInput || loading) return;

    const userQuestion = trimmedInput;
    setInput("");
    setMessages((prev) => [...prev, {text:userQuestion,isBot:false}]);
    setLoading(true);

    try{
      const response = await fetch("http://localhost:5001/api/chat",{
        method:"POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({question: userQuestion}),
      });

      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        throw new Error(data.error || "The server returned an error.");
      }

      setMessages((prev) => [...prev, {text: data.answer || "No answer returned.", isBot: true}]);
    }catch(e){
      setMessages((prev) => [...prev, {text: e.message || "Error connecting to the server.",isBot:true}]);
    }finally{
      setLoading(false);
    }
  };

  return (
    <div style={{ maxWidth: "600px", margin: "50px auto", border: "1px solid #ccc", borderRadius: "8px", fontFamily: "sans-serif", boxShadow: "0 4px 6px rgba(0,0,0,0.1)" }}>
      <div style={{ background: "#007bff", color: "white", padding: "15px", textAlign: "center", borderTopLeftRadius: "7px", borderTopRightRadius: "7px" }}>
        <h3 style={{ margin: 0 }}>DAA Study Buddy</h3>
      </div>
      
      <div style={{ height: "400px", overflowY: "auto", padding: "20px", background: "#f8f9fa" }}>
        {messages.map((msg, i) => (
          <div key={i} style={{ textAlign: msg.isBot ? "left" : "right", margin: "10px 0" }}>
            <span style={{
              background: msg.isBot ? "#e9ecef" : "#007bff",
              color: msg.isBot ? "black" : "white",
              padding: "8px 12px",
              borderRadius: "15px",
              display: "inline-block",
              maxWidth: "70%",
              wordBreak: "break-word"
            }}>
              {msg.text}
            </span>
          </div>
        ))}
        {loading && <div style={{ color: "#888", fontSize: "14px", fontStyle: "italic" }}>Chef Llama is typing...</div>}
      </div>

      <form onSubmit={handleSend} style={{ display: "flex", borderTop: "1px solid #ccc" }}>
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Ask a question..."
          disabled={loading}
          style={{ flex: 1, padding: "15px", border: "none", outline: "none", borderRadius: "0 0 0 7px" }}
        />
        <button type="submit" disabled={loading} style={{ padding: "15px 25px", background: loading ? "#6c757d" : "#007bff", color: "white", border: "none", cursor: loading ? "not-allowed" : "pointer", borderRadius: "0 0 7px 0" }}>
          {loading ? "Working..." : "Send"}
        </button>
      </form>
    </div>
  );


}


export default App
