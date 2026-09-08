import React, { useState, useEffect } from "react";

export default function QuestionCard() {
    const [step, setStep] = useState("onboarding"); // "onboarding" | "quiz" | "summary"
    const [formData, setFormData] = useState({
        name: "",
        subject: "Mathematics",
        difficulty: "Beginner",
        preparation_stage: "Just Starting",
        num_questions: 5,   // Default question count
        time_limit: 10      // Default time limit in minutes
    });

    const [currentQuestionIndex, setCurrentQuestionIndex] = useState(1);
    const [question, setQuestion] = useState(null);
    const [selectedOption, setSelectedOption] = useState(null);
    const [loading, setLoading] = useState(false);
    const [submitting, setSubmitting] = useState(false);
    const [result, setResult] = useState(null);

    // Timer state in seconds
    const [timeLeft, setTimeLeft] = useState(0);

    const API_BASE = "http://127.0.0.1:8000/api";

    // Active Timer Effect
    useEffect(() => {
        if (step !== "quiz" || timeLeft <= 0) return;

        const timer = setInterval(() => {
            setTimeLeft((prev) => {
                if (prev <= 1) {
                    clearInterval(timer);
                    alert("Time is up! Submitting your diagnostic session.");
                    setStep("summary");
                    return 0;
                }
                return prev - 1;
            });
        }, 1000);

        return () => clearInterval(timer);
    }, [step, timeLeft]);

    // Format seconds to MM:SS
    const formatTime = (seconds) => {
        const mins = Math.floor(seconds / 60);
        const secs = seconds % 60;
        return `${mins.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
    };

    // Onboarding Submit
    const handleOnboardSubmit = async (e) => {
        e.preventDefault();
        setLoading(true);

        const payload = {
            name: formData.name.trim() || "Student",
            subject: formData.subject,
            difficulty: formData.difficulty,
            preparation_stage: formData.preparation_stage,
        };

        try {
            const res = await fetch(`${API_BASE}/onboard`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload),
            });

            if (!res.ok) throw new Error("Failed to fetch initial question");

            const data = await res.json();
            setQuestion(data);
            setCurrentQuestionIndex(1);

            // Initialize timer based on custom user input (minutes to seconds)
            setTimeLeft(formData.time_limit * 60);
            setStep("quiz");
        } catch (err) {
            console.error("Onboarding error:", err);
        } finally {
            setLoading(false);
        }
    };

    // Submit Current Answer
    const handleAnswerSubmit = async () => {
        if (!selectedOption || !question) return;

        setSubmitting(true);
        try {
            const res = await fetch(`${API_BASE}/attempts`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    user_id: 1,
                    question_id: question.id || 1,
                    selected_answer: selectedOption,
                }),
            });

            const data = await res.json();
            setResult(data);
        } catch (err) {
            console.error("Answer submission failed:", err);
        } finally {
            setSubmitting(false);
        }
    };

    // Advance to Next Question
    const handleNextQuestion = async () => {
        if (currentQuestionIndex >= formData.num_questions) {
            setStep("summary");
            return;
        }

        setLoading(true);
        setSelectedOption(null);
        setResult(null);

        try {
            const res = await fetch(`${API_BASE}/onboard`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(formData),
            });
            const data = await res.json();
            setQuestion(data);
            setCurrentQuestionIndex((prev) => prev + 1);
        } catch (err) {
            console.error("Failed to load next question:", err);
        } finally {
            setLoading(false);
        }
    };

    const inputStyle = {
        width: "100%",
        padding: "0.75rem",
        borderRadius: "6px",
        border: "1px solid #334155",
        backgroundColor: "#1e293b",
        color: "#fff",
        boxSizing: "border-box",
    };

    return (
        <div style={{ minHeight: "100vh", backgroundColor: "#020617", color: "#f8fafc", padding: "2rem", display: "flex", justifyContent: "center", alignItems: "center", fontFamily: "sans-serif" }}>
            <div style={{ maxWidth: "600px", width: "100%", backgroundColor: "#0f172a", padding: "2rem", borderRadius: "12px", border: "1px solid #1e293b" }}>

                {/* STEP 1: CUSTOM SETUP */}
                {step === "onboarding" && (
                    <form onSubmit={handleOnboardSubmit} style={{ display: "flex", flexDirection: "column", gap: "1.25rem" }}>
                        <h2 style={{ fontSize: "1.5rem", fontWeight: "bold", borderBottom: "1px solid #334155", paddingBottom: "0.75rem", margin: 0 }}>Diagnostic Setup</h2>

                        <div>
                            <label style={{ display: "block", fontSize: "0.875rem", marginBottom: "0.5rem", color: "#cbd5e1" }}>Your Name</label>
                            <input type="text" required value={formData.name} onChange={(e) => setFormData({ ...formData, name: e.target.value })} placeholder="e.g. Daniel" style={inputStyle} />
                        </div>

                        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "1rem" }}>
                            <div>
                                <label style={{ display: "block", fontSize: "0.875rem", marginBottom: "0.5rem", color: "#cbd5e1" }}>Subject</label>
                                <select value={formData.subject} onChange={(e) => setFormData({ ...formData, subject: e.target.value })} style={inputStyle}>
                                    <option value="Mathematics">Mathematics</option>
                                    <option value="Physics">Physics</option>
                                    <option value="Computer Science">Computer Science</option>
                                    <option value="Chemistry">Chemistry</option>
                                </select>
                            </div>

                            <div>
                                <label style={{ display: "block", fontSize: "0.875rem", marginBottom: "0.5rem", color: "#cbd5e1" }}>Difficulty</label>
                                <select value={formData.difficulty} onChange={(e) => setFormData({ ...formData, difficulty: e.target.value })} style={inputStyle}>
                                    <option value="Beginner">Beginner</option>
                                    <option value="Intermediate">Intermediate</option>
                                    <option value="Advanced">Advanced</option>
                                </select>
                            </div>
                        </div>

                        {/* CUSTOM NUMERIC INPUTS */}
                        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "1rem" }}>
                            <div>
                                <label style={{ display: "block", fontSize: "0.875rem", marginBottom: "0.5rem", color: "#cbd5e1" }}>Total Questions</label>
                                <input
                                    type="number"
                                    min="1"
                                    max="20"
                                    value={formData.num_questions}
                                    onChange={(e) => setFormData({ ...formData, num_questions: Math.max(1, parseInt(e.target.value) || 1) })}
                                    style={inputStyle}
                                />
                            </div>

                            <div>
                                <label style={{ display: "block", fontSize: "0.875rem", marginBottom: "0.5rem", color: "#cbd5e1" }}>Time Limit (Minutes)</label>
                                <input
                                    type="number"
                                    min="1"
                                    max="120"
                                    value={formData.time_limit}
                                    onChange={(e) => setFormData({ ...formData, time_limit: Math.max(1, parseInt(e.target.value) || 1) })}
                                    style={inputStyle}
                                />
                            </div>
                        </div>

                        <button type="submit" disabled={loading} style={{ marginTop: "0.5rem", padding: "0.875rem", backgroundColor: loading ? "#334155" : "#4f46e5", color: "#fff", border: "none", borderRadius: "6px", fontWeight: "bold", cursor: loading ? "not-allowed" : "pointer" }}>
                            {loading ? "Generating Quiz..." : "Start Diagnostic →"}
                        </button>
                    </form>
                )}

                {/* STEP 2: QUIZ SESSION WITH LIVE TIMER */}
                {step === "quiz" && (
                    <div>
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1rem" }}>
                            <span style={{ color: "#818cf8", fontSize: "0.875rem", fontWeight: "bold" }}>
                                Question {currentQuestionIndex} of {formData.num_questions}
                            </span>
                            <span style={{ color: timeLeft < 60 ? "#f87171" : "#38bdf8", fontWeight: "bold", fontFamily: "monospace", fontSize: "1.1rem" }}>
                                ⏱ {formatTime(timeLeft)}
                            </span>
                        </div>

                        <h2 style={{ fontSize: "1.25rem", marginBottom: "1.5rem" }}>{question?.question}</h2>

                        <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem", marginBottom: "1.5rem" }}>
                            {question?.options.map((option, idx) => (
                                <button
                                    key={idx}
                                    disabled={!!result}
                                    onClick={() => setSelectedOption(option)}
                                    style={{
                                        padding: "1rem",
                                        textAlign: "left",
                                        borderRadius: "6px",
                                        border: selectedOption === option ? "2px solid #6366f1" : "1px solid #334155",
                                        backgroundColor: selectedOption === option ? "#1e1b4b" : "#1e293b",
                                        color: "#f8fafc",
                                        cursor: result ? "not-allowed" : "pointer",
                                    }}
                                >
                                    {option}
                                </button>
                            ))}
                        </div>

                        {!result ? (
                            <button
                                onClick={handleAnswerSubmit}
                                disabled={!selectedOption || submitting}
                                style={{ width: "100%", padding: "0.875rem", backgroundColor: !selectedOption || submitting ? "#334155" : "#4f46e5", color: "#fff", border: "none", borderRadius: "6px", fontWeight: "bold", cursor: "pointer" }}
                            >
                                {submitting ? "Checking..." : "Submit Answer"}
                            </button>
                        ) : (
                            <button
                                onClick={handleNextQuestion}
                                disabled={loading}
                                style={{ width: "100%", padding: "0.875rem", backgroundColor: "#059669", color: "#fff", border: "none", borderRadius: "6px", fontWeight: "bold", cursor: "pointer" }}
                            >
                                {loading ? "Loading Next..." : currentQuestionIndex >= formData.num_questions ? "Finish Session" : "Next Question →"}
                            </button>
                        )}

                        {/* AI DIAGNOSTIC FEEDBACK */}
                        {result && (
                            <div style={{ marginTop: "1.5rem", paddingTop: "1rem", borderTop: "1px solid #334155" }}>
                                {result.is_correct ? (
                                    <div style={{ backgroundColor: "#064e3b", padding: "1rem", borderRadius: "6px", color: "#a7f3d0" }}>✓ Correct!</div>
                                ) : (
                                    <div style={{ backgroundColor: "#1e1b4b", padding: "1rem", borderRadius: "6px", border: "1px solid #4338ca" }}>
                                        <p style={{ color: "#f87171", fontWeight: "bold", margin: "0 0 0.5rem 0" }}>✕ Incorrect. Correct Answer: {result.correct_answer}</p>
                                        {result.misconception_analysis && (
                                            <p style={{ color: "#cbd5e1", fontSize: "0.875rem", margin: 0 }}>
                                                {result.misconception_analysis.targeted_explanation}
                                            </p>
                                        )}
                                    </div>
                                )}
                            </div>
                        )}
                    </div>
                )}

                {/* STEP 3: SESSION SUMMARY */}
                {step === "summary" && (
                    <div style={{ textAlign: "center", padding: "1rem 0" }}>
                        <h2 style={{ fontSize: "1.5rem", marginBottom: "1rem" }}>Diagnostic Session Complete! 🎉</h2>
                        <p style={{ color: "#cbd5e1", marginBottom: "2rem" }}>You answered {formData.num_questions} questions for {formData.subject}.</p>
                        <button
                            onClick={() => {
                                setResult(null);
                                setSelectedOption(null);
                                setStep("onboarding");
                            }}
                            style={{ padding: "0.875rem 1.5rem", backgroundColor: "#4f46e5", color: "#fff", border: "none", borderRadius: "6px", fontWeight: "bold", cursor: "pointer" }}
                        >
                            Start New Diagnostic Session
                        </button>
                    </div>
                )}

            </div>
        </div>
    );
}